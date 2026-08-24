import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { CakeAnchoredSchedule, CakeIntervalSchedule } from "@t3tools/contracts";
import { nextRunAfter } from "./cakeSchedule.ts";

/**
 * A cake's schedule decides when a full-access agent runs unattended, so the
 * arithmetic is the feature. Every case below is one the naive implementation
 * gets wrong: `now + interval` drags the series later on every late call, a
 * wall-clock time is not a fixed offset from UTC twice a year, February has no
 * 31st, and `every 1 second` is a fork bomb.
 *
 * These moved here with `nextRunAfter` itself. The suites that stayed in
 * `contracts` are the ones testing what stayed: the interval floor and the
 * clock-face conversions the schemas and the form both need.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const every = (count: number, unit: CakeIntervalSchedule["unit"]): CakeIntervalSchedule => ({
  kind: "every",
  count,
  unit,
});

const dailyAt = (
  hour: number,
  meridiem: CakeAnchoredSchedule["meridiem"] = "AM",
  timeZone = "America/New_York",
): CakeAnchoredSchedule => ({ kind: "at", cadence: "day", hour, meridiem, timeZone });

const at = (iso: string): number => Date.parse(iso);

describe("nextRunAfter — interval mode", () => {
  it("places every slot on a multiple of its own period", () => {
    const period = 90 * 1000;
    expect(nextRunAfter(every(90, "second"), at("2026-03-10T00:00:00.000Z"))).toBe(
      at("2026-03-10T00:01:30.000Z"),
    );
    expect(nextRunAfter(every(90, "second"), at("2026-03-10T00:00:00.000Z")) % period).toBe(0);
  });

  /**
   * The whole point of the grid. Asked twenty seconds late, the answer is the
   * slot that was already coming — not twenty seconds after it.
   */
  it("does not drag the series when it is asked late", () => {
    const schedule = every(90, "second");
    const onTime = nextRunAfter(schedule, at("2026-03-10T00:00:00.000Z"));
    const askedLate = nextRunAfter(schedule, at("2026-03-10T00:00:20.000Z"));
    expect(askedLate).toBe(onTime);
  });

  it("keeps the spacing exact across consecutive slots, however late each call is", () => {
    const schedule = every(19, "minute");
    const period = 19 * MINUTE_MS;
    const first = nextRunAfter(schedule, at("2026-03-10T00:00:00.000Z"));
    // Three minutes after the slot fired: the next one is a period from the
    // slot, not a period from the moment somebody got round to asking.
    const second = nextRunAfter(schedule, first + 3 * MINUTE_MS);
    expect(first % period).toBe(0);
    expect(second - first).toBe(period);
  });

  it("advances when called exactly on a slot", () => {
    const schedule = every(1, "hour");
    expect(nextRunAfter(schedule, at("2026-03-10T14:00:00.000Z"))).toBe(
      at("2026-03-10T15:00:00.000Z"),
    );
  });

  it("returns the top of the next hour for an hourly interval", () => {
    expect(nextRunAfter(every(1, "hour"), at("2026-03-10T14:23:45.000Z"))).toBe(
      at("2026-03-10T15:00:00.000Z"),
    );
  });

  /**
   * Months have no fixed length, so the grid is counted in months from the
   * epoch rather than in milliseconds. Every slot sits on the 1st, a day that
   * exists in every month, so nothing has to clamp.
   */
  it("counts a month interval on a calendar grid, not on 30-day blocks", () => {
    const next = nextRunAfter(every(2, "month"), at("2026-03-10T00:00:00.000Z"));
    expect(next).toBe(at("2026-05-01T00:00:00.000Z"));
  });

  it("returns a future instant even after a long outage", () => {
    const from = at("2026-06-01T12:34:56.000Z");
    const next = nextRunAfter(every(19, "minute"), from);
    expect(next).toBeGreaterThan(from);
    // One slot, never a backlog: the gap can never exceed one period.
    expect(next - from).toBeLessThanOrEqual(19 * MINUTE_MS);
  });
});

describe("nextRunAfter — anchored mode", () => {
  it("returns today's slot when it is still ahead", () => {
    // 9 AM in New York on 2026-03-10 (EDT, UTC-4) is 13:00Z.
    expect(nextRunAfter(dailyAt(9), at("2026-03-10T11:00:00.000Z"))).toBe(
      at("2026-03-10T13:00:00.000Z"),
    );
  });

  it("rolls to tomorrow once today's slot has passed", () => {
    expect(nextRunAfter(dailyAt(9), at("2026-03-10T13:30:00.000Z"))).toBe(
      at("2026-03-11T13:00:00.000Z"),
    );
  });

  it("advances when called exactly at the slot", () => {
    expect(nextRunAfter(dailyAt(9), at("2026-03-10T13:00:00.000Z"))).toBe(
      at("2026-03-11T13:00:00.000Z"),
    );
  });

  /**
   * 12 AM and 12 PM are the two hours the clock-face conversion can silently
   * invert, and a cake that runs at midnight instead of noon is a cake nobody
   * notices is wrong until it has run for a week.
   */
  it("puts 12 AM at midnight and 12 PM at noon", () => {
    const midnight = dailyAt(12, "AM", "UTC");
    const noon = dailyAt(12, "PM", "UTC");
    expect(nextRunAfter(midnight, at("2026-03-10T01:00:00.000Z"))).toBe(
      at("2026-03-11T00:00:00.000Z"),
    );
    expect(nextRunAfter(noon, at("2026-03-10T01:00:00.000Z"))).toBe(at("2026-03-10T12:00:00.000Z"));
  });

  it("respects a different timezone entirely", () => {
    const tokyo = dailyAt(9, "AM", "Asia/Tokyo");
    // Tokyo is UTC+9 year round: 9 AM local on the 11th is 00:00Z that day.
    expect(nextRunAfter(tokyo, at("2026-03-10T12:00:00.000Z"))).toBe(
      at("2026-03-11T00:00:00.000Z"),
    );
  });
});

/**
 * The reason a schedule carries a timezone rather than a UTC offset. In 2026
 * the United States moves to EDT on March 8th, so a 9 AM cake is 14:00Z before
 * that date and 13:00Z after it. Storing an offset would silently shift every
 * scheduled run by an hour, twice a year.
 */
describe("nextRunAfter — daylight saving", () => {
  it("keeps wall-clock time across a spring-forward boundary", () => {
    // Before the change: EST, UTC-5.
    expect(nextRunAfter(dailyAt(9), at("2026-03-06T00:00:00.000Z"))).toBe(
      at("2026-03-06T14:00:00.000Z"),
    );
    // After it: EDT, UTC-4. Same 9 AM, different instant.
    expect(nextRunAfter(dailyAt(9), at("2026-03-09T00:00:00.000Z"))).toBe(
      at("2026-03-09T13:00:00.000Z"),
    );
  });

  it("keeps wall-clock time across an autumn fall-back boundary", () => {
    // 2026-11-01 is the change; before it EDT, after it EST.
    expect(nextRunAfter(dailyAt(9), at("2026-10-30T00:00:00.000Z"))).toBe(
      at("2026-10-30T13:00:00.000Z"),
    );
    expect(nextRunAfter(dailyAt(9), at("2026-11-03T00:00:00.000Z"))).toBe(
      at("2026-11-03T14:00:00.000Z"),
    );
  });

  /**
   * The case that justifies resolving the offset twice.
   *
   * On 2026-03-08 New York springs forward at 2 AM local (07:00Z). A 3 AM slot
   * is 07:00Z, but naively reading the offset at "03:00 treated as UTC" sees
   * the pre-transition EST offset and lands an hour late at 08:00Z. Any cake
   * scheduled within the offset window of a transition hits this; a single-pass
   * conversion is wrong for all of them and right everywhere else, which is
   * exactly how it survives casual testing.
   */
  it("resolves a slot that straddles the transition itself", () => {
    expect(nextRunAfter(dailyAt(3), at("2026-03-08T00:00:00.000Z"))).toBe(
      at("2026-03-08T07:00:00.000Z"),
    );
  });
});

describe("nextRunAfter — weekly, fortnightly and monthly", () => {
  it("weekly lands seven days apart", () => {
    const schedule: CakeAnchoredSchedule = {
      kind: "at",
      cadence: "week",
      hour: 9,
      meridiem: "AM",
      timeZone: "UTC",
    };
    const first = nextRunAfter(schedule, at("2026-03-10T00:00:00.000Z"));
    expect(nextRunAfter(schedule, first) - first).toBe(7 * DAY_MS);
  });

  /**
   * Fortnightly is the cadence most likely to be implemented as "weekly, but
   * skip one", which drifts the moment a slot is missed. Two weeks means
   * fourteen days — not seven, and not fifteen because a month rolled over.
   */
  it("bi-weekly lands fourteen days apart", () => {
    const schedule: CakeAnchoredSchedule = {
      kind: "at",
      cadence: "bi-weekly",
      hour: 9,
      meridiem: "AM",
      timeZone: "UTC",
    };
    const first = nextRunAfter(schedule, at("2026-03-10T00:00:00.000Z"));
    const second = nextRunAfter(schedule, first);
    expect(second - first).toBe(14 * DAY_MS);
    expect(second - first).not.toBe(7 * DAY_MS);
    expect(second - first).not.toBe(15 * DAY_MS);
  });

  it("monthly lands on the same day of the following month", () => {
    const schedule: CakeAnchoredSchedule = {
      kind: "at",
      cadence: "month",
      hour: 9,
      meridiem: "AM",
      timeZone: "UTC",
    };
    const first = nextRunAfter(schedule, at("2026-03-10T00:00:00.000Z"));
    const second = nextRunAfter(schedule, first);
    expect(DateTime.getPartUtc(DateTime.makeUnsafe(second), "day")).toBe(
      DateTime.getPartUtc(DateTime.makeUnsafe(first), "day"),
    );
    expect(second).toBeGreaterThan(first);
  });

  /**
   * A monthly cake set on the 31st has no February 31st. Clamping to the last
   * real day is the only answer that keeps the cake running; rolling into March
   * would skip a month silently.
   */
  it("clamps a monthly slot to the last day of a shorter month", () => {
    const schedule: CakeAnchoredSchedule = {
      kind: "at",
      cadence: "month",
      hour: 9,
      meridiem: "AM",
      timeZone: "UTC",
    };
    const next = nextRunAfter(schedule, at("2026-01-31T12:00:00.000Z"));
    const asDate = DateTime.makeUnsafe(next);
    expect(DateTime.getPartUtc(asDate, "month")).toBe(2); // February
    expect(DateTime.getPartUtc(asDate, "day")).toBe(28); // 2026 is not a leap year
  });
});

/**
 * Missed runs are skipped, not replayed. Whatever slots passed while the app
 * was closed, the answer is the next slot in the future — never a backlog.
 */
describe("nextRunAfter — never returns the past", () => {
  it("returns a future instant even after a long outage", () => {
    const from = at("2026-06-01T00:00:00.000Z");
    expect(nextRunAfter(dailyAt(9), from)).toBeGreaterThan(from);
  });

  it("returns exactly one slot, not a queue of missed ones", () => {
    const from = at("2026-06-01T00:00:00.000Z");
    // The gap can never exceed one cadence period; a backlog would show up here
    // as a stale timestamp close to `from`.
    expect(nextRunAfter(dailyAt(9), from) - from).toBeLessThanOrEqual(DAY_MS);
  });
});
