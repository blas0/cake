import { describe, expect, it } from "vite-plus/test";

import { COMPOSER_MENTION_DRAG_TYPE } from "../chat/composerMentionDrag.ts";
import { CAKE_DRAG_TYPE } from "./cakeDrag.ts";
import { startCakeDrag } from "./cakeDragSource.ts";
import type { CakeDropDecision } from "./cakeDropDecision.ts";
import { makeCakeDropHandlers, type CakeDropEvent } from "./cakeDropHandlers.ts";

/**
 * One cake, dragged from the shelf and dropped on a thread.
 *
 * `cakeDragSource.test.ts` and `cakeDropHandlers.test.ts` each test one half
 * against a hand-written stand-in for the other, so both would keep passing if
 * the two halves stopped agreeing — a renamed MIME type, a payload shape only
 * one side knows. Nothing carries a real transfer from the source that writes
 * it to the target that reads it. This does.
 *
 * `FakeDataTransfer` is the reason it is worth doing: it behaves the way the
 * DOM object does rather than the way each side's stub assumed. `types` is
 * whatever was actually written, and `getData` of a format nobody wrote is the
 * empty string, not undefined. A drag that never called `setData` therefore
 * reads as no cake here for the same reason it would in a browser.
 */

class FakeDataTransfer {
  private readonly entries = new Map<string, string>();
  public effectAllowed = "uninitialized";
  public dropEffect = "none";

  get types(): ReadonlyArray<string> {
    return [...this.entries.keys()];
  }

  setData(format: string, value: string): void {
    this.entries.set(format, value);
  }

  getData(format: string): string {
    return this.entries.get(format) ?? "";
  }
}

interface Landing {
  readonly decisions: ReadonlyArray<CakeDropDecision>;
  readonly dragActive: ReadonlyArray<boolean>;
  readonly claimed: number;
}

const dropTarget = (thread: {
  threadId: string | null;
  threadHasStarted?: boolean;
  threadIsBusy: boolean;
}) => {
  const decisions: Array<CakeDropDecision> = [];
  const dragActive: Array<boolean> = [];
  let claimed = 0;
  const handlers = makeCakeDropHandlers({
    readThread: () => ({ ...thread, threadHasStarted: thread.threadHasStarted ?? true }),
    setDragActive: (active) => dragActive.push(active),
    onDecision: (decision) => decisions.push(decision),
  });

  // The drop target is one element that also takes OS files and file mentions,
  // so "did this handler claim the event" is a fact about the drop, not an
  // implementation detail: claiming one it cannot service eats the other drop.
  const event = (transfer: FakeDataTransfer, within = false): CakeDropEvent => ({
    dataTransfer: transfer,
    relatedTarget: within ? ({} as EventTarget) : null,
    currentTarget: { contains: () => within },
    nativeEvent: { stopPropagation: () => undefined },
    preventDefault: () => {
      claimed += 1;
    },
    stopPropagation: () => undefined,
  });

  const landing = (): Landing => ({ decisions, dragActive, claimed });
  return { handlers, event, landing };
};

/** A cake picked up off the shelf, on a transfer that behaves like the browser's. */
const draggedCake = (cakeId: string): FakeDataTransfer => {
  const transfer = new FakeDataTransfer();
  startCakeDrag({ dataTransfer: transfer }, cakeId);
  return transfer;
};

describe("a cake dragged from the shelf onto a thread", () => {
  it("attaches that cake when the thread is idle", () => {
    const target = dropTarget({ threadId: "thread-1", threadIsBusy: false });
    target.handlers.onDrop(target.event(draggedCake("cake-1")));

    expect(target.landing().decisions).toEqual([
      { kind: "attach", cakeId: "cake-1", threadId: "thread-1" },
    ]);
  });

  /**
   * The busy thread is the whole reason the ask exists: interrupting it would
   * throw away work the user can watch happening. Both answers have to be
   * offered, and forking — the one that loses nothing — has to come first.
   */
  it("asks, offering both a fork and a stop, when the thread is busy", () => {
    const target = dropTarget({ threadId: "thread-1", threadIsBusy: true });
    target.handlers.onDrop(target.event(draggedCake("cake-1")));

    expect(target.landing().decisions).toEqual([
      {
        kind: "ask",
        cakeId: "cake-1",
        threadId: "thread-1",
        options: ["fork", "stop-and-spawn"],
      },
    ]);
  });

  /**
   * The source names "copy" and the target answers "copy". If they disagreed
   * the browser would cancel the drop before it ever fired, and every test of
   * either half on its own would still be green.
   */
  it("agrees with itself about the drop effect across both halves", () => {
    const transfer = draggedCake("cake-1");
    expect(transfer.effectAllowed).toBe("copy");

    const target = dropTarget({ threadId: "thread-1", threadIsBusy: false });
    target.handlers.onDragOver(target.event(transfer));

    expect(transfer.dropEffect).toBe("copy");
  });

  it("highlights the thread on the way in and lets go of it on the drop", () => {
    const target = dropTarget({ threadId: "thread-1", threadIsBusy: false });
    const transfer = draggedCake("cake-1");
    target.handlers.onDragEnter(target.event(transfer));
    target.handlers.onDrop(target.event(transfer));

    expect(target.landing().dragActive).toEqual([true, false]);
  });

  it("lets go of the highlight when the drag leaves without dropping", () => {
    const target = dropTarget({ threadId: "thread-1", threadIsBusy: false });
    const transfer = draggedCake("cake-1");
    target.handlers.onDragEnter(target.event(transfer));
    target.handlers.onDragLeave(target.event(transfer));

    expect(target.landing().dragActive).toEqual([true, false]);
  });
});

describe("a drag that is not a cake", () => {
  /**
   * The MIME type exists so a cake cannot be confused with the other things
   * dropped on this element. A mention dragged out of the file tree has to pass
   * straight through — unclaimed, so the composer's own handler still gets it.
   */
  it("passes a file-tree mention through untouched", () => {
    const transfer = new FakeDataTransfer();
    transfer.setData(COMPOSER_MENTION_DRAG_TYPE, JSON.stringify({ path: "src/index.ts" }));

    const target = dropTarget({ threadId: "thread-1", threadIsBusy: false });
    target.handlers.onDragEnter(target.event(transfer));
    target.handlers.onDrop(target.event(transfer));
    const landing = target.landing();

    expect(landing.claimed).toBe(0);
    expect(landing.dragActive).toEqual([]);
    expect(landing.decisions).toEqual([]);
  });

  it("ignores a drag that never wrote a payload at all", () => {
    const target = dropTarget({ threadId: "thread-1", threadIsBusy: false });
    target.handlers.onDrop(target.event(new FakeDataTransfer()));

    expect(target.landing().decisions).toEqual([]);
  });

  /**
   * Anything can write to a drag transfer, and this id goes straight into a
   * call that starts an unattended agent. Rubbish under the cake type is a drop
   * that does nothing, not a throw and not a spawn.
   */
  it("does nothing with rubbish written under the cake's own type", () => {
    const transfer = new FakeDataTransfer();
    transfer.setData(CAKE_DRAG_TYPE, "}{ not json");

    const target = dropTarget({ threadId: "thread-1", threadIsBusy: false });
    expect(() => target.handlers.onDrop(target.event(transfer))).not.toThrow();
    expect(target.landing().decisions).toEqual([]);
  });

  it("does nothing with a cake payload that names no cake", () => {
    const transfer = new FakeDataTransfer();
    transfer.setData(CAKE_DRAG_TYPE, JSON.stringify({ cakeId: "   " }));

    const target = dropTarget({ threadId: "thread-1", threadIsBusy: false });
    target.handlers.onDrop(target.event(transfer));

    expect(target.landing().decisions).toEqual([]);
  });

  /** A cake with no id never becomes a drag, so the target never sees one. */
  it("is never started for a cake with no id", () => {
    const transfer = new FakeDataTransfer();
    expect(startCakeDrag({ dataTransfer: transfer }, "  ")).toBe(false);
    expect(transfer.types).toEqual([]);
  });
});
