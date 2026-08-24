import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  cakeStopRequest,
  deriveCakeShelfRow,
  deriveCakeThreadEntries,
  forkedCakeThreadTitle,
  formatCakeNextRun,
  resolveRunningCakeId,
  runningCakeEntry,
} from "./cakeThreadModel.ts";

/**
 * What the composer knows about the cakes attached to the thread in front of it.
 *
 * All of it is derived: the server reports attachments, and the composer turns
 * them into a control that is shown or hidden and a set of switches. Keeping
 * that derivation here is what makes it checkable at all — the components it
 * feeds cannot be rendered in this repo's test setup.
 */

const cakes = [
  { id: "cake-1", name: "Nightly triage" },
  { id: "cake-2", name: "Dependency bump" },
];

/**
 * The wire sends `DateTimeUtc` now, so these fixtures hold decoded instants
 * rather than ISO strings — the parse moved to the boundary.
 */
const at = (iso: string): DateTime.Utc => DateTime.makeUnsafe(iso);

describe("deriveCakeThreadEntries", () => {
  it("names each attachment from the cake it points at", () => {
    const entries = deriveCakeThreadEntries({
      cakes,
      attachments: [{ cakeId: "cake-1", enabled: true, nextRunAt: null }],
      runningCakeId: null,
    });

    expect(entries).toEqual([
      { cakeId: "cake-1", name: "Nightly triage", enabled: true, status: "idle" },
    ]);
  });

  it("reports an enabled attachment with a next slot as scheduled", () => {
    const entries = deriveCakeThreadEntries({
      cakes,
      attachments: [{ cakeId: "cake-1", enabled: true, nextRunAt: at("2026-01-01T09:00:00.000Z") }],
      runningCakeId: null,
    });

    expect(entries[0]?.status).toBe("scheduled");
  });

  /**
   * Switching a cake off on this thread is the whole point of the composer
   * control, so a disabled attachment must not keep claiming it is scheduled
   * just because a stale slot is still recorded against it.
   */
  it("does not call a disabled attachment scheduled, even with a slot recorded", () => {
    const entries = deriveCakeThreadEntries({
      cakes,
      attachments: [
        { cakeId: "cake-1", enabled: false, nextRunAt: at("2026-01-01T09:00:00.000Z") },
      ],
      runningCakeId: null,
    });

    expect(entries[0]?.status).toBe("idle");
  });

  it("reports the running cake as active whatever its schedule says", () => {
    const entries = deriveCakeThreadEntries({
      cakes,
      attachments: [{ cakeId: "cake-1", enabled: true, nextRunAt: at("2026-01-01T09:00:00.000Z") }],
      runningCakeId: "cake-1",
    });

    expect(entries[0]?.status).toBe("active");
  });

  /**
   * A deleted cake can leave an attachment behind. Rendering a row
   * for it would put a nameless switch in the composer that toggles nothing.
   */
  it("drops attachments whose cake no longer exists", () => {
    const entries = deriveCakeThreadEntries({
      cakes,
      attachments: [{ cakeId: "cake-gone", enabled: true, nextRunAt: null }],
      runningCakeId: null,
    });

    expect(entries).toEqual([]);
  });

  it("keeps the order the attachments arrived in", () => {
    const entries = deriveCakeThreadEntries({
      cakes,
      attachments: [
        { cakeId: "cake-2", enabled: true, nextRunAt: null },
        { cakeId: "cake-1", enabled: true, nextRunAt: null },
      ],
      runningCakeId: null,
    });

    expect(entries.map((entry) => entry.cakeId)).toEqual(["cake-2", "cake-1"]);
  });
});

describe("runningCakeEntry", () => {
  it("finds the active entry so the Stop Cake button can name it", () => {
    const entries = deriveCakeThreadEntries({
      cakes,
      attachments: [
        { cakeId: "cake-1", enabled: true, nextRunAt: null },
        { cakeId: "cake-2", enabled: true, nextRunAt: null },
      ],
      runningCakeId: "cake-2",
    });

    expect(runningCakeEntry(entries)?.name).toBe("Dependency bump");
  });

  it("is null when nothing is running, so the button stays hidden", () => {
    const entries = deriveCakeThreadEntries({
      cakes,
      attachments: [{ cakeId: "cake-1", enabled: true, nextRunAt: null }],
      runningCakeId: null,
    });

    expect(runningCakeEntry(entries)).toBe(null);
  });
});

/**
 * Which cake is running is tracked by the client that started it. There is no
 * field on the wire that reports it, so the answer is only ever "the one this
 * client fired, while the thread is still busy" — and it must go back to null
 * the moment either half of that stops holding, or the Stop Cake button
 * outlives the run it claims to stop.
 */
describe("resolveRunningCakeId", () => {
  const pending = { threadId: "t1", cakeId: "cake-1" } as const;

  it("reports the cake this client fired while the thread is busy", () => {
    expect(resolveRunningCakeId({ pending, threadId: "t1", threadIsBusy: true })).toBe("cake-1");
  });

  it("forgets it once the thread goes idle", () => {
    expect(resolveRunningCakeId({ pending, threadId: "t1", threadIsBusy: false })).toBe(null);
  });

  it("does not follow the user to another thread", () => {
    expect(resolveRunningCakeId({ pending, threadId: "t2", threadIsBusy: true })).toBe(null);
  });

  it("reports nothing when this client fired nothing", () => {
    expect(resolveRunningCakeId({ pending: null, threadId: "t1", threadIsBusy: true })).toBe(null);
  });

  /**
   * The scheduler is how cakes normally run, and it sets no `pending` on any
   * client. Without the server's answer the Stop Cake button never appeared for
   * the one case it exists for, so this is the regression the server lookup
   * closes.
   */
  it("reports the cake the server names even though this client fired nothing", () => {
    expect(
      resolveRunningCakeId({
        serverCakeId: "cake-9",
        pending: null,
        threadId: "t1",
        threadIsBusy: true,
      }),
    ).toBe("cake-9");
  });

  /**
   * The server round-trip lands a moment after the click. Until it does, the
   * local record is the only thing that can light the button, so it has to keep
   * working on its own.
   */
  it("still reports the local run while the server has not answered", () => {
    expect(
      resolveRunningCakeId({ serverCakeId: null, pending, threadId: "t1", threadIsBusy: true }),
    ).toBe("cake-1");
  });

  /**
   * A stale `pending` outlives its run — the user fires a cake, it finishes, the
   * scheduler starts a different one. Only one of the two sources is written
   * down anywhere, so that one wins.
   */
  it("prefers the server's answer when the two disagree", () => {
    expect(
      resolveRunningCakeId({ serverCakeId: "cake-2", pending, threadId: "t1", threadIsBusy: true }),
    ).toBe("cake-2");
  });

  it("reports nothing on an idle thread however loudly either source claims a run", () => {
    expect(
      resolveRunningCakeId({
        serverCakeId: "cake-2",
        pending,
        threadId: "t1",
        threadIsBusy: false,
      }),
    ).toBe(null);
  });
});

/**
 * The shelf's second line. Every case here is fixed against an explicit instant
 * and an explicit zone, because "today" is the whole question being asked and a
 * test that read the host clock would answer it differently after midnight.
 */
describe("formatCakeNextRun", () => {
  const timeZone = "UTC";
  const now = Date.parse("2026-03-12T14:30:00.000Z");

  it("says today when the slot falls on the day being looked at", () => {
    expect(
      formatCakeNextRun({ nextRunAt: at("2026-03-12T21:00:00.000Z"), nowMs: now, timeZone }),
    ).toBe("Next run: 9:00 PM, today");
  });

  it("names the date when the slot falls on another day", () => {
    expect(
      formatCakeNextRun({ nextRunAt: at("2026-03-13T09:00:00.000Z"), nowMs: now, timeZone }),
    ).toBe("Next run: 9:00 AM, Mar 13");
  });

  /**
   * Midnight is the boundary the label turns on, and it is a boundary in the
   * reader's zone rather than in UTC.
   */
  it("reads the day in the zone it was given, not in UTC", () => {
    expect(
      formatCakeNextRun({
        nextRunAt: at("2026-03-13T02:00:00.000Z"),
        nowMs: now,
        timeZone: "America/New_York",
      }),
    ).toBe("Next run: 10:00 PM, today");
  });

  /**
   * A cake with no attachment, or a disabled one, has no next slot. Saying so
   * is the point: a row that rendered "Invalid Date" would read as a bug in the
   * schedule rather than as a cake that is switched off.
   */
  it("says so in words when there is no slot", () => {
    expect(formatCakeNextRun({ nextRunAt: null, nowMs: now, timeZone })).toBe(
      "Next run: not scheduled",
    );
  });

  /**
   * This used to assert that an unparseable timestamp rendered as "not
   * scheduled". It cannot arise any more: the contract carries `DateTimeUtc`,
   * so the only thing that reaches this function is an instant or null — a
   * string cannot cross at all. The guarantee moved to the boundary; see
   * `cakeErrors.test.ts`, "refuses a timestamp that is still a string".
   *
   * Rendering "not scheduled" for a malformed instant was the wrong answer
   * anyway: it reads as a cake with no schedule rather than as a server that
   * wrote a bad timestamp, and told nobody either way.
   */
});

/**
 * Which of the row's two buttons is drawn, and what the lock is showing. Both
 * are decisions rather than rendering, so both are answered here and the panel
 * only reads them.
 */
describe("deriveCakeShelfRow", () => {
  const nowMs = Date.parse("2026-03-12T14:30:00.000Z");
  const base = { nowMs, timeZone: "UTC" } as const;

  it("shows Start for a cake the thread is not running", () => {
    const row = deriveCakeShelfRow({
      ...base,
      cakeId: "cake-1",
      attachments: [{ cakeId: "cake-1", enabled: true, nextRunAt: null }],
      runningCakeId: "cake-2",
    });

    expect(row.isRunning).toBe(false);
  });

  it("shows Stop for the cake that is running", () => {
    const row = deriveCakeShelfRow({
      ...base,
      cakeId: "cake-1",
      attachments: [{ cakeId: "cake-1", enabled: true, nextRunAt: null }],
      runningCakeId: "cake-1",
    });

    expect(row.isRunning).toBe(true);
  });

  it("reports the attachment's enabled state, so the lock reflects it", () => {
    const row = deriveCakeShelfRow({
      ...base,
      cakeId: "cake-1",
      attachments: [{ cakeId: "cake-1", enabled: false, nextRunAt: null }],
      runningCakeId: null,
    });

    expect(row.enabled).toBe(false);
  });

  /**
   * The shelf lists the whole environment, so most rows have no attachment on
   * the thread in front of the user. That is "off", not "missing".
   */
  it("reads a cake with no attachment as off and unscheduled", () => {
    const row = deriveCakeShelfRow({
      ...base,
      cakeId: "cake-1",
      attachments: [],
      runningCakeId: null,
    });

    expect(row).toEqual({
      cakeId: "cake-1",
      enabled: false,
      isRunning: false,
      status: "idle",
      nextRunLabel: "Next run: not scheduled",
    });
  });

  /**
   * Disabling is what the lock is for, and the promise it makes is that the
   * cake stops running. A stale slot left on the row would keep announcing one.
   */
  it("hides a stale slot recorded against a disabled attachment", () => {
    const row = deriveCakeShelfRow({
      ...base,
      cakeId: "cake-1",
      attachments: [
        { cakeId: "cake-1", enabled: false, nextRunAt: at("2026-03-12T21:00:00.000Z") },
      ],
      runningCakeId: null,
    });

    expect(row.nextRunLabel).toBe("Next run: not scheduled");
  });

  it("shows the slot of an enabled attachment", () => {
    const row = deriveCakeShelfRow({
      ...base,
      cakeId: "cake-1",
      attachments: [{ cakeId: "cake-1", enabled: true, nextRunAt: at("2026-03-12T21:00:00.000Z") }],
      runningCakeId: null,
    });

    expect(row.nextRunLabel).toBe("Next run: 9:00 PM, today");
  });
});

describe("forkedCakeThreadTitle", () => {
  it("says which cake is running and which thread it came from", () => {
    expect(forkedCakeThreadTitle("Nightly triage", "Fix the flaky test")).toBe(
      "Nightly triage in Fix the flaky test",
    );
  });

  it("falls back to the cake alone when the thread has no title yet", () => {
    expect(forkedCakeThreadTitle("Nightly triage", "   ")).toBe("Nightly triage");
  });
});

/**
 * Stopping a cake is two things, and only one of them can be skipped. The
 * interrupt halts the agent and always happens; this decides whether there is a
 * run to close as well.
 */
describe("cakeStopRequest", () => {
  it("names the running cake and the thread it runs on", () => {
    expect(cakeStopRequest({ runningCakeId: "cake-1", threadId: "thread-1" })).toEqual({
      cakeId: "cake-1",
      threadId: "thread-1",
    });
  });

  it("records nothing when no cake is running", () => {
    expect(cakeStopRequest({ runningCakeId: null, threadId: "thread-1" })).toBe(null);
  });

  it("records nothing when there is no thread to name", () => {
    expect(cakeStopRequest({ runningCakeId: "cake-1", threadId: null })).toBe(null);
  });
});
