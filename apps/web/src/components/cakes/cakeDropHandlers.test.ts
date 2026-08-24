import { describe, expect, it } from "vite-plus/test";

import { CAKE_DRAG_TYPE, serializeCakeDrag } from "./cakeDrag.ts";
import type { CakeDropDecision } from "./cakeDropDecision.ts";
import { makeCakeDropHandlers, type CakeDropEvent } from "./cakeDropHandlers.ts";

/**
 * The receiving half of the cake drag, on the thread container and the composer.
 *
 * Both drop targets already accept OS files, file mentions and text, so the
 * behaviour worth pinning down is what this handler does to drags that are not
 * cakes: nothing at all. Claiming a drag it cannot use would swallow the file
 * drop that was actually meant.
 */

interface Recorded {
  readonly dragActive: boolean[];
  readonly decisions: CakeDropDecision[];
  readonly prevented: number;
  readonly stopped: number;
  readonly nativeStopped: number;
}

const makeHarness = (thread: {
  threadId: string | null;
  threadHasStarted?: boolean;
  threadIsBusy: boolean;
}) => {
  const dragActive: boolean[] = [];
  const decisions: CakeDropDecision[] = [];
  const counts = { prevented: 0, stopped: 0, nativeStopped: 0 };
  const handlers = makeCakeDropHandlers({
    readThread: () => ({ ...thread, threadHasStarted: thread.threadHasStarted ?? true }),
    setDragActive: (active) => dragActive.push(active),
    onDecision: (decision) => decisions.push(decision),
  });
  const recorded = (): Recorded => ({ dragActive, decisions, ...counts });
  const event = (options: {
    types?: ReadonlyArray<string>;
    payload?: string;
    relatedTarget?: EventTarget | null;
    contains?: boolean;
  }): CakeDropEvent & { dropEffect: () => string } => {
    const dataTransfer = {
      types: options.types ?? [CAKE_DRAG_TYPE],
      dropEffect: "none",
      getData: (format: string) =>
        format === CAKE_DRAG_TYPE ? (options.payload ?? serializeCakeDrag("cake-1")) : "",
    };
    return {
      dataTransfer,
      relatedTarget: options.relatedTarget ?? null,
      currentTarget: { contains: () => options.contains ?? false },
      nativeEvent: {
        stopPropagation: () => {
          counts.nativeStopped += 1;
        },
      },
      preventDefault: () => {
        counts.prevented += 1;
      },
      stopPropagation: () => {
        counts.stopped += 1;
      },
      dropEffect: () => dataTransfer.dropEffect,
    };
  };
  return { handlers, event, recorded };
};

describe("makeCakeDropHandlers", () => {
  it("highlights the target and names the copy effect while a cake is over it", () => {
    const { handlers, event, recorded } = makeHarness({ threadId: "t1", threadIsBusy: false });
    const over = event({});
    handlers.onDragEnter(event({}));
    handlers.onDragOver(over);

    expect(recorded().dragActive).toEqual([true, true]);
    expect(over.dropEffect()).toBe("copy");
  });

  /**
   * Both drop targets sit inside containers that handle their own drags. React's
   * stopPropagation only halts the synthetic dispatch, so the native event has
   * to be stopped too or the composer's own DOM listeners still see the drag.
   */
  it("claims the event from every listener above it", () => {
    const { handlers, event, recorded } = makeHarness({ threadId: "t1", threadIsBusy: false });
    handlers.onDrop(event({}));
    const seen = recorded();

    expect(seen.prevented).toBe(1);
    expect(seen.stopped).toBe(1);
    expect(seen.nativeStopped).toBe(1);
  });

  it("attaches on an idle thread", () => {
    const { handlers, event, recorded } = makeHarness({ threadId: "t1", threadIsBusy: false });
    handlers.onDrop(event({}));

    expect(recorded().decisions).toEqual([{ kind: "attach", cakeId: "cake-1", threadId: "t1" }]);
  });

  it("asks before starting on an unstarted thread", () => {
    const { handlers, event, recorded } = makeHarness({
      threadId: "t1",
      threadHasStarted: false,
      threadIsBusy: false,
    });
    handlers.onDrop(event({}));

    expect(recorded().decisions).toEqual([{ kind: "ask-start", cakeId: "cake-1", threadId: "t1" }]);
  });

  it("asks rather than interrupting a busy thread", () => {
    const { handlers, event, recorded } = makeHarness({ threadId: "t1", threadIsBusy: true });
    handlers.onDrop(event({}));

    expect(recorded().decisions[0]?.kind).toBe("ask");
  });

  it("clears the highlight when the drop lands", () => {
    const { handlers, event, recorded } = makeHarness({ threadId: "t1", threadIsBusy: false });
    handlers.onDragOver(event({}));
    handlers.onDrop(event({}));

    expect(recorded().dragActive).toEqual([true, false]);
  });

  /**
   * A drag crossing a child element fires dragleave on the parent. Dropping the
   * highlight there makes it strobe as the pointer moves across the transcript.
   */
  it("keeps the highlight while the drag moves within the target", () => {
    const { handlers, event, recorded } = makeHarness({ threadId: "t1", threadIsBusy: false });
    handlers.onDragOver(event({}));
    handlers.onDragLeave(event({ relatedTarget: {} as EventTarget, contains: true }));

    expect(recorded().dragActive).toEqual([true]);
  });

  it("clears the highlight when the drag actually leaves", () => {
    const { handlers, event, recorded } = makeHarness({ threadId: "t1", threadIsBusy: false });
    handlers.onDragOver(event({}));
    handlers.onDragLeave(event({ relatedTarget: {} as EventTarget, contains: false }));

    expect(recorded().dragActive).toEqual([true, false]);
  });

  /**
   * The important negative. These targets also take OS files and file mentions;
   * calling preventDefault on those would claim a drop this handler cannot
   * service, and the file the user dragged would silently vanish.
   */
  it("leaves drags that are not cakes entirely alone", () => {
    const { handlers, event, recorded } = makeHarness({ threadId: "t1", threadIsBusy: false });
    const files = { types: ["Files"] as ReadonlyArray<string> };
    handlers.onDragEnter(event(files));
    handlers.onDragOver(event(files));
    handlers.onDragLeave(event(files));
    handlers.onDrop(event(files));
    const seen = recorded();

    expect(seen.prevented).toBe(0);
    expect(seen.stopped).toBe(0);
    expect(seen.dragActive).toEqual([]);
    expect(seen.decisions).toEqual([]);
  });

  it("does not act on a cake drag that carries a malformed payload", () => {
    const { handlers, event, recorded } = makeHarness({ threadId: "t1", threadIsBusy: false });
    handlers.onDrop(event({ payload: "not json" }));

    expect(recorded().decisions).toEqual([]);
  });

  it("does not act when there is no thread to drop onto", () => {
    const { handlers, event, recorded } = makeHarness({ threadId: null, threadIsBusy: false });
    handlers.onDrop(event({}));

    expect(recorded().decisions).toEqual([]);
  });
});
