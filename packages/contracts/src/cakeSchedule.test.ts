import { describe, expect, it } from "vite-plus/test";

import {
  CAKE_MINIMUM_INTERVAL_SECONDS,
  cakeIntervalSeconds,
  isCakeIntervalTooShort,
  to12Hour,
  to24Hour,
} from "./cakeSchedule.ts";

/**
 * A cake's schedule decides when a full-access agent runs unattended, so the
 * arithmetic is the feature. Every case below is one the naive implementation
 * gets wrong: `now + interval` drags the series later on every late call, a
 * wall-clock time is not a fixed offset from UTC twice a year, February has no
 * 31st, and `every 1 second` is a fork bomb.
 *
 * All functions take the current instant as an argument. Nothing here reads a
 * clock — a scheduler you cannot place in time is a scheduler you cannot test.
 */

describe("the 60-second floor", () => {
  /**
   * The floor is not a preference. A cake spawns a full-access agent with
   * nobody watching, and the reactor's tick is 30 seconds — so a sub-minute
   * interval is both a fork bomb and a promise the machine cannot keep.
   */
  it("refuses anything under a minute and accepts exactly a minute", () => {
    expect(isCakeIntervalTooShort(59, "second")).toBe(true);
    expect(isCakeIntervalTooShort(60, "second")).toBe(false);
    expect(CAKE_MINIMUM_INTERVAL_SECONDS).toBe(60);
  });

  /**
   * `second` stays a legal unit. What is refused is the total, so `every 90
   * seconds` — a cadence with no other spelling in this model — survives.
   */
  it("keeps seconds usable above the floor", () => {
    expect(isCakeIntervalTooShort(90, "second")).toBe(false);
    expect(isCakeIntervalTooShort(1, "second")).toBe(true);
  });

  it("refuses a count that is not a whole number of periods at all", () => {
    expect(isCakeIntervalTooShort(0, "hour")).toBe(true);
    expect(isCakeIntervalTooShort(-1, "day")).toBe(true);
    expect(isCakeIntervalTooShort(1.5, "minute")).toBe(true);
  });

  it("accepts every unit above the floor at a count of one", () => {
    for (const unit of ["minute", "hour", "day", "week", "month"] as const) {
      expect(isCakeIntervalTooShort(1, unit)).toBe(false);
    }
  });

  it("measures an interval in seconds", () => {
    expect(cakeIntervalSeconds(19, "minute")).toBe(19 * 60);
    expect(cakeIntervalSeconds(2, "hour")).toBe(7200);
  });
});

describe("12-hour clock conversion", () => {
  /**
   * The two cases every naive `hour % 12` gets wrong. Midnight and noon both
   * land on 12, and which meridiem they take is the difference between a cake
   * running at 3am and a cake running at 3pm.
   */
  it("maps 0 to 12 AM and 12 to 12 PM", () => {
    expect(to12Hour(0)).toEqual({ hour12: 12, meridiem: "AM" });
    expect(to12Hour(12)).toEqual({ hour12: 12, meridiem: "PM" });
    expect(to24Hour(12, "AM")).toBe(0);
    expect(to24Hour(12, "PM")).toBe(12);
  });

  it("round-trips every hour of the day", () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const { hour12, meridiem } = to12Hour(hour);
      expect(to24Hour(hour12, meridiem)).toBe(hour);
    }
  });
});

/**
 * Interval mode counts from a fixed origin, not from "the last time this ran".
 * Anchoring to the previous run lets a deferred or late call drag the whole
 * series later and later — a cake set to every 19 minutes slowly becomes every
 * 22 — and the drift is invisible until someone compares two days of logs.
 */
