import { describe, expect, it } from "vite-plus/test";

import type { CakeSchedule } from "@t3tools/contracts";

import { decideCakeTick, type DueCake } from "./cakeTick.ts";

/**
 * One scheduler tick, as a pure decision.
 *
 * The policy lives here rather than in the reactor so it can be tested without
 * a clock, a database or a worker — the repo forbids sleep-based tests, and a
 * scheduler is the one component most tempting to write one for. The reactor
 * around this does IO and nothing else.
 *
 * Three outcomes, and the difference between two of them is the whole point:
 * a **deferred** run is still owed and will fire when the machine is willing,
 * while a **missed** one is gone and only recorded. Collapsing them would
 * either lose work or stampede a busy machine with a backlog.
 */

const schedule: CakeSchedule = {
  kind: "at",
  cadence: "day",
  hour: 9,
  meridiem: "AM",
  timeZone: "UTC",
};

const at = (iso: string): number => Date.parse(iso);

const due = (overrides: Partial<DueCake> = {}): DueCake => ({
  cakeId: "cake-1",
  threadId: "thread-1",
  nextRunAt: at("2026-03-10T09:00:00.000Z"),
  schedule,
  ...overrides,
});

describe("decideCakeTick", () => {
  it("fires a slot that has just arrived", () => {
    const decisions = decideCakeTick({
      now: at("2026-03-10T09:00:30.000Z"),
      shouldRunOpportunisticWork: true,
      due: [due()],
    });

    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.kind).toBe("fire");
  });

  it("advances the slot it fired so the same run cannot fire twice", () => {
    const [decision] = decideCakeTick({
      now: at("2026-03-10T09:00:30.000Z"),
      shouldRunOpportunisticWork: true,
      due: [due()],
    });

    if (decision?.kind !== "fire") throw new Error(`expected a fire, got ${decision?.kind}`);
    expect(decision.nextRunAt).toBeGreaterThan(at("2026-03-10T09:00:30.000Z"));
  });

  it("returns nothing when nothing is due", () => {
    expect(
      decideCakeTick({
        now: at("2026-03-10T09:00:00.000Z"),
        shouldRunOpportunisticWork: true,
        due: [],
      }),
    ).toEqual([]);
  });

  /**
   * The machine being busy is not the same as the run being unwanted. A
   * deferred cake keeps its slot exactly where it was, so the next willing tick
   * still sees it as due — deferring by advancing the slot would silently drop
   * the run it was trying to protect.
   */
  it("defers rather than skipping when the host is unwilling", () => {
    const decisions = decideCakeTick({
      now: at("2026-03-10T09:00:30.000Z"),
      shouldRunOpportunisticWork: false,
      due: [due()],
    });

    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.kind).toBe("defer");
  });

  it("leaves a deferred slot untouched so the next willing tick still sees it", () => {
    const original = due();
    const [decision] = decideCakeTick({
      now: at("2026-03-10T09:00:30.000Z"),
      shouldRunOpportunisticWork: false,
      due: [original],
    });

    if (decision?.kind !== "defer") throw new Error(`expected a defer, got ${decision?.kind}`);
    // A defer that rescheduled would be a skip wearing a friendlier name.
    expect(decision).not.toHaveProperty("nextRunAt");
  });

  /**
   * A slot that passed while the app was closed is missed, not owed. Firing it
   * on launch would run a nightly cake at whatever hour the user happened to
   * open the app, and firing every slot that passed would run it a dozen times
   * at once.
   */
  it("skips a slot that passed long ago rather than firing it late", () => {
    const decisions = decideCakeTick({
      now: at("2026-06-01T12:00:00.000Z"),
      shouldRunOpportunisticWork: true,
      due: [due({ nextRunAt: at("2026-03-10T09:00:00.000Z") })],
    });

    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.kind).toBe("skip-missed");
  });

  it("moves a missed slot forward to a future one, not to the next past one", () => {
    const now = at("2026-06-01T12:00:00.000Z");
    const [decision] = decideCakeTick({
      now,
      shouldRunOpportunisticWork: true,
      due: [due({ nextRunAt: at("2026-03-10T09:00:00.000Z") })],
    });

    if (decision?.kind !== "skip-missed") {
      throw new Error(`expected a skip-missed, got ${decision?.kind}`);
    }
    // Advancing one period at a time would leave it still in the past and the
    // scheduler would grind through months of slots on every tick.
    expect(decision.nextRunAt).toBeGreaterThan(now);
  });

  /**
   * A run a few seconds late is the normal case — a tick interval is not
   * instant. Treating ordinary lateness as "missed" would mean a scheduler that
   * never actually runs anything.
   */
  it("treats a slightly late slot as fired, not missed", () => {
    const decisions = decideCakeTick({
      now: at("2026-03-10T09:04:00.000Z"),
      shouldRunOpportunisticWork: true,
      due: [due()],
    });

    expect(decisions[0]?.kind).toBe("fire");
  });

  it("decides each due cake independently", () => {
    const decisions = decideCakeTick({
      now: at("2026-06-01T12:00:00.000Z"),
      shouldRunOpportunisticWork: true,
      due: [
        due({ cakeId: "fresh", nextRunAt: at("2026-06-01T11:59:00.000Z") }),
        due({ cakeId: "stale", nextRunAt: at("2026-03-10T09:00:00.000Z") }),
      ],
    });

    expect(decisions.map((decision) => decision.kind)).toEqual(["fire", "skip-missed"]);
  });

  /**
   * An unwilling host defers everything, including slots old enough to be
   * missed. Recording a miss is a write, and the point of deferring is to do no
   * work at all until the machine is willing.
   */
  it("defers even a long-passed slot when the host is unwilling", () => {
    const decisions = decideCakeTick({
      now: at("2026-06-01T12:00:00.000Z"),
      shouldRunOpportunisticWork: false,
      due: [due({ nextRunAt: at("2026-03-10T09:00:00.000Z") })],
    });

    expect(decisions[0]?.kind).toBe("defer");
  });
});
