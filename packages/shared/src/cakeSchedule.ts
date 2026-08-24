/**
 * When a cake next runs.
 *
 * Calendar arithmetic, timezone conversion and scheduling policy — runtime
 * behaviour, not a wire shape. It lived in `packages/contracts` beside the
 * schemas it reads, which put ~170 lines of policy in the package this repo
 * otherwise keeps to schemas and small derivations (`contracts/background.ts`
 * holds the shapes; `shared/backgroundActivitySettings.ts` holds the decisions).
 *
 * What stayed behind in `cakeSchedule.ts` stayed for a reason rather than by
 * oversight: `isCakeTimeZone`, `isCakeIntervalTooShort` and the minimum-interval
 * constants are consumed by the schemas themselves, and `contracts` cannot
 * import `shared` — its only dependency is `effect`. So the seam is drawn where
 * it can actually be drawn, and the residue is named here so the next reader
 * does not mistake it for the same oversight twice.
 */

import * as DateTime from "effect/DateTime";
import {
  CAKE_MINIMUM_INTERVAL_SECONDS,
  type CakeAnchorCadence,
  type CakeAnchoredSchedule,
  type CakeIntervalUnit,
  to24Hour,
  type CakeSchedule,
} from "@t3tools/contracts";

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/**
 * The instant at which a given wall-clock time occurs in a zone.
 *
 * `adjustForTimeZone` is the whole trick: it reads the input as wall-clock time
 * in the target zone rather than as a UTC instant, which is what keeps a 9 AM
 * cake at 9 AM on both sides of a daylight-saving change. Doing this by hand
 * means resolving the offset, correcting, and resolving again — the first guess
 * is wrong whenever the guess and the answer straddle a transition, which is
 * every early-morning slot on a spring-forward day.
 */
function instantForWallClock(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
): number {
  return DateTime.toEpochMillis(
    DateTime.makeZonedUnsafe(Date.UTC(year, month, day, hour, 0, 0, 0), {
      timeZone,
      adjustForTimeZone: true,
    }),
  );
}

/** The calendar date showing on a wall clock in `timeZone` at `instant`. */
function wallClockDate(
  timeZone: string,
  instant: number,
): { year: number; month: number; day: number } {
  const zoned = DateTime.makeZonedUnsafe(instant, { timeZone });
  return {
    year: DateTime.getPart(zoned, "year"),
    month: DateTime.getPart(zoned, "month") - 1,
    day: DateTime.getPart(zoned, "day"),
  };
}

/** Days in a month, so a monthly slot can clamp instead of overflowing. */
function daysInMonth(year: number, month: number): number {
  // Day 0 of the following month is the last day of this one.
  return DateTime.getPartUtc(DateTime.makeUnsafe(Date.UTC(year, month + 1, 0)), "day");
}

/**
 * The origin every cadence counts from: midnight UTC on the Unix epoch. Any
 * fixed point works; what matters is that it never moves, so the grid of valid
 * slots is the same answer no matter when it is asked.
 */
const GRID_ORIGIN_DAY = 0;

/** Fixed-length units, in milliseconds. `month` is absent because it has none. */
const FIXED_UNIT_MS: Record<Exclude<CakeIntervalUnit, "month">, number> = {
  second: SECOND_MS,
  minute: MINUTE_MS,
  hour: HOUR_MS,
  day: DAY_MS,
  week: WEEK_MS,
};

/** How many days apart two consecutive slots of an anchored cadence sit. */
function anchorStride(cadence: CakeAnchorCadence): number {
  switch (cadence) {
    case "week":
      return 7;
    case "bi-weekly":
      return 14;
    default:
      return 1;
  }
}

/**
 * The next slot of an interval whose unit has a fixed length.
 *
 * Flooring onto a multiple of the period is what makes the series undraggable:
 * `now + period` would push every subsequent slot later by however late this
 * call happened to be, and a cake asked twice in the same period would answer
 * twice.
 */
function nextFixedIntervalSlot(
  count: number,
  unit: Exclude<CakeIntervalUnit, "month">,
  from: number,
): number {
  // Below the floor is unreachable through the validated boundary — the stored
  // schema refuses it too now — but the clamp stays: a hand-built schedule that
  // divided by zero would return NaN and silently unschedule the cake rather
  // than fail.
  const period = Math.max(count * FIXED_UNIT_MS[unit], CAKE_MINIMUM_INTERVAL_SECONDS * SECOND_MS);
  return Math.floor(from / period) * period + period;
}

/**
 * The next slot of a month-counted interval.
 *
 * Months have no fixed length, so the grid is counted in months from the epoch
 * rather than in milliseconds, and every slot sits at midnight UTC on the 1st —
 * a day that exists in every month, so nothing has to clamp.
 */
function nextMonthIntervalSlot(count: number, from: number): number {
  const step = Math.max(1, Math.trunc(count));
  const now = DateTime.makeUnsafe(from);
  const monthsSinceEpoch =
    (DateTime.getPartUtc(now, "year") - 1970) * 12 + (DateTime.getPartUtc(now, "month") - 1);
  const aligned = Math.floor(monthsSinceEpoch / step) * step;
  const candidate = instantForWallClock("UTC", 1970, aligned, 1, 0);
  return candidate > from ? candidate : instantForWallClock("UTC", 1970, aligned + step, 1, 0);
}

/** The next slot of an anchored monthly cadence, clamped to a real day. */
function nextAnchoredMonthSlot(schedule: CakeAnchoredSchedule, from: number, hour: number): number {
  const today = wallClockDate(schedule.timeZone, from);
  for (let ahead = 0; ahead <= 2; ahead += 1) {
    const year = today.year + Math.floor((today.month + ahead) / 12);
    const month = (today.month + ahead) % 12;
    // A cake set on the 31st has no 31st in February. Clamping to the last real
    // day keeps it running; rolling into March would skip a month in silence.
    const day = Math.min(today.day, daysInMonth(year, month));
    const candidate = instantForWallClock(schedule.timeZone, year, month, day, hour);
    if (candidate > from) return candidate;
  }
  // Unreachable for real inputs; keeps the function total.
  return from + 31 * DAY_MS;
}

/** The next slot of an anchored daily, weekly or fortnightly cadence. */
function nextAnchoredDaySlot(schedule: CakeAnchoredSchedule, from: number, hour: number): number {
  const stride = anchorStride(schedule.cadence);
  const today = wallClockDate(schedule.timeZone, from);
  // Walk forward from today to the first slot that is both on the fixed grid
  // and in the future. At most `stride` days are examined.
  for (let ahead = 0; ahead <= stride; ahead += 1) {
    const candidate = instantForWallClock(
      schedule.timeZone,
      today.year,
      today.month,
      today.day + ahead,
      hour,
    );
    if (candidate <= from) continue;
    const dayIndex = Math.floor(candidate / DAY_MS);
    if ((dayIndex - GRID_ORIGIN_DAY) % stride !== 0) continue;
    return candidate;
  }
  return instantForWallClock(schedule.timeZone, today.year, today.month, today.day + stride, hour);
}

/**
 * The next instant this schedule fires, strictly after `from`.
 *
 * Strictly after matters: called exactly at a slot, returning that same slot
 * would re-fire the run that just happened, forever. And exactly one instant
 * comes back, never a backlog — slots that passed while the app was closed are
 * missed, by design.
 */
export function nextRunAfter(schedule: CakeSchedule, from: number): number {
  if (schedule.kind === "every") {
    return schedule.unit === "month"
      ? nextMonthIntervalSlot(schedule.count, from)
      : nextFixedIntervalSlot(schedule.count, schedule.unit, from);
  }

  const hour = to24Hour(schedule.hour, schedule.meridiem);
  return schedule.cadence === "month"
    ? nextAnchoredMonthSlot(schedule, from, hour)
    : nextAnchoredDaySlot(schedule, from, hour);
}
