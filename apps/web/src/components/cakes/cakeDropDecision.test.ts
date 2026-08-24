import { describe, expect, it } from "vite-plus/test";

import { decideCakeDrop } from "./cakeDropDecision.ts";

/**
 * What dropping a cake on a thread does depends on whether that thread is busy.
 *
 * The busy case is the one worth getting right: an agent is mid-turn, and
 * silently interrupting it would throw away work the user can see happening.
 * So the drop asks — and the two answers it offers are the two things a user
 * could reasonably mean.
 */

describe("decideCakeDrop", () => {
  it("asks to start when the thread exists but has not spoken", () => {
    expect(
      decideCakeDrop({
        cakeId: "cake-1",
        threadId: "thread-1",
        threadHasStarted: false,
        threadIsBusy: false,
      }),
    ).toEqual({ kind: "ask-start", cakeId: "cake-1", threadId: "thread-1" });
  });

  it("attaches immediately when the started thread is idle", () => {
    expect(
      decideCakeDrop({
        cakeId: "cake-1",
        threadId: "thread-1",
        threadHasStarted: true,
        threadIsBusy: false,
      }),
    ).toEqual({
      kind: "attach",
      cakeId: "cake-1",
      threadId: "thread-1",
    });
  });

  /**
   * Never interrupt without asking. The dialog is not a confirmation step to
   * click through — it is the only place the user learns that a turn is
   * already running here.
   */
  it("asks rather than interrupting when an agent is working", () => {
    const decision = decideCakeDrop({
      cakeId: "cake-1",
      threadId: "thread-1",
      threadHasStarted: true,
      threadIsBusy: true,
    });
    expect(decision.kind).toBe("ask");
  });

  it("offers both a fork and a stop-and-spawn", () => {
    const decision = decideCakeDrop({
      cakeId: "cake-1",
      threadId: "thread-1",
      threadHasStarted: true,
      threadIsBusy: true,
    });
    if (decision.kind !== "ask") throw new Error(`expected an ask, got ${decision.kind}`);
    expect(decision.options).toEqual(["fork", "stop-and-spawn"]);
  });

  it("carries both ids through so the dialog needs no extra lookup", () => {
    const decision = decideCakeDrop({
      cakeId: "cake-1",
      threadId: "thread-1",
      threadHasStarted: true,
      threadIsBusy: true,
    });
    if (decision.kind !== "ask") throw new Error(`expected an ask, got ${decision.kind}`);
    expect(decision.cakeId).toBe("cake-1");
    expect(decision.threadId).toBe("thread-1");
  });

  /**
   * A drop that carried no cake is not a drop. This is the last gate before an
   * agent starts, so it refuses rather than guessing.
   */
  it("refuses a drop with no cake", () => {
    expect(
      decideCakeDrop({
        cakeId: null,
        threadId: "thread-1",
        threadHasStarted: false,
        threadIsBusy: false,
      }),
    ).toEqual({ kind: "ignore" });
  });

  it("refuses a drop with no thread", () => {
    expect(
      decideCakeDrop({
        cakeId: "cake-1",
        threadId: null,
        threadHasStarted: false,
        threadIsBusy: false,
      }),
    ).toEqual({ kind: "ignore" });
  });
});
