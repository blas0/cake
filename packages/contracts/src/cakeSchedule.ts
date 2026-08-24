import * as Schema from "effect/Schema";

/**
 * When a cake runs.
 *
 * A schedule is one of exactly two shapes, and the discriminant is `kind`.
 * An **interval** schedule is the CLI form the user already knows — `/loop
 * <prompt> 19m` — said as "every 19 minutes". An **anchored** schedule is the
 * calendar form: "every day at 9 AM", in a named zone, on the hour.
 *
 * Three properties are load-bearing and none of them is obvious from the field
 * names.
 *
 * An anchored schedule stores a **timezone**, not a UTC offset. A cake set for
 * 9 AM means 9 AM in the user's morning, and the offset that corresponds to is
 * different either side of a daylight-saving boundary. Storing `-05:00` would
 * shift every scheduled run by an hour, twice a year, silently.
 *
 * Every cadence counts from a **fixed origin**, not from the previous run.
 * Anchoring to "three days after last time" lets a deferred or missed run drag
 * the whole series later and later, so a cake set to every three days quietly
 * becomes every four. Both modes therefore land on an absolute grid: the
 * interval mode floors the instant onto a multiple of its own period rather
 * than returning `now + period`. The grid is absolute; a missed slot is simply
 * missed.
 *
 * Nothing here reads a clock. Every function takes the current instant as an
 * argument, because a scheduler you cannot place in time is a scheduler you
 * cannot test.
 */

export const CAKE_INTERVAL_UNITS = ["second", "minute", "hour", "day", "week", "month"] as const;

export const CakeIntervalUnit = Schema.Literals(CAKE_INTERVAL_UNITS);
export type CakeIntervalUnit = typeof CakeIntervalUnit.Type;

/** `bi-weekly` is every two weeks. Spelling it out beats a `count` nobody sees. */
export const CAKE_ANCHOR_CADENCES = ["day", "week", "bi-weekly", "month"] as const;

export const CakeAnchorCadence = Schema.Literals(CAKE_ANCHOR_CADENCES);
export type CakeAnchorCadence = typeof CakeAnchorCadence.Type;

export const CAKE_MERIDIEMS = ["AM", "PM"] as const;

export const CakeMeridiem = Schema.Literals(CAKE_MERIDIEMS);
export type CakeMeridiem = typeof CakeMeridiem.Type;

/**
 * The bounds a stored schedule has to satisfy, shared with the input schemas in
 * `cakeRpc.ts` rather than restated there.
 *
 * They lived only on the inputs, which made the refusals a property of one
 * doorway instead of of the data: anything decoded back out of SQLite — the
 * path every scheduler tick takes — was range-unchecked, which is why
 * `nextFixedIntervalSlot` below needs a defensive clamp against NaN.
 */
export const CakeClockHour = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 }));
export const CakeIntervalCount = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 10_000 }),
);

/**
 * An IANA zone, and specifically not an offset.
 *
 * `Intl` is the arbiter of the first half — it is the same table
 * `DateTime.makeZonedUnsafe` consults, so agreeing with it is the point. It
 * accepts offsets too (`+05:30` validates), so the second half is spelled out:
 * an offset is a fixed number of hours, and a cake anchored to one drifts an
 * hour away from the time the user chose on every daylight-saving change.
 */
const OFFSET_LIKE = /^[+-]\d{2}:?\d{2}$/;

export function isCakeTimeZone(value: string): boolean {
  if (OFFSET_LIKE.test(value.trim())) return false;
  try {
    // The constructor is the check: it throws `RangeError` for a zone the
    // runtime's table does not hold. Kept as a value rather than a bare `new`
    // so it reads as a probe rather than a side effect.
    const probe = new Intl.DateTimeFormat(undefined, { timeZone: value });
    return probe.resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

export const CakeTimeZone = Schema.String.check(
  Schema.makeFilter((value) =>
    isCakeTimeZone(value) ? undefined : "Must be an IANA time zone, such as America/New_York.",
  ),
);

/** "Run cake every `count` `unit`". */
export const CakeIntervalSchedule = Schema.Struct({
  kind: Schema.Literal("every"),
  count: CakeIntervalCount,
  unit: CakeIntervalUnit,
});
export type CakeIntervalSchedule = typeof CakeIntervalSchedule.Type;

/**
 * "Run cake every `cadence` at `hour` `meridiem`".
 *
 * Hour granularity only. A minute field would be a fourth control on a form
 * whose whole point is that it is answerable in one glance, and the scheduler
 * ticks in tens of seconds anyway.
 */
export const CakeAnchoredSchedule = Schema.Struct({
  kind: Schema.Literal("at"),
  cadence: CakeAnchorCadence,
  /** 1–12, as it reads on a clock face. */
  hour: CakeClockHour,
  meridiem: CakeMeridiem,
  /** An IANA zone such as `America/New_York`. Never an offset — enforced. */
  timeZone: CakeTimeZone,
});
export type CakeAnchoredSchedule = typeof CakeAnchoredSchedule.Type;

export const CakeSchedule = Schema.Union([CakeIntervalSchedule, CakeAnchoredSchedule]);
export type CakeSchedule = typeof CakeSchedule.Type;

/**
 * The shortest interval a cake may be given, in seconds.
 *
 * Two independent reasons, either of which is sufficient. A cake spawns a
 * full-access agent unattended, so `every 1 second` is a fork bomb with a
 * friendly name. And the scheduler's tick is 30 seconds
 * (`DEFAULT_TICK_INTERVAL_MS` in `CakeScheduleReactor.ts`), so anything under a
 * minute cannot be honoured even in principle — accepting it would promise a
 * cadence the machine will never deliver.
 *
 * `second` stays a legal unit: `every 90 seconds` is a perfectly good schedule.
 * What is refused is the total, not the unit.
 */
export const CAKE_MINIMUM_INTERVAL_SECONDS = 60;

export const CAKE_MINIMUM_INTERVAL_MESSAGE =
  `A cake runs a full-access agent unattended and the scheduler ticks every 30 seconds, ` +
  `so an interval must be at least ${CAKE_MINIMUM_INTERVAL_SECONDS} seconds.`;

/**
 * Seconds per unit, for the floor check only.
 *
 * A month is taken as its shortest possible length. The number is never used to
 * place a slot — `nextRunAfter` walks the calendar for that — so the only thing
 * that matters here is that no month is ever mistaken for something under a
 * minute.
 */
const INTERVAL_UNIT_SECONDS: Record<CakeIntervalUnit, number> = {
  second: 1,
  minute: 60,
  hour: 60 * 60,
  day: 24 * 60 * 60,
  week: 7 * 24 * 60 * 60,
  month: 28 * 24 * 60 * 60,
};

/** How long an interval schedule actually waits, in seconds. */
export function cakeIntervalSeconds(count: number, unit: CakeIntervalUnit): number {
  return count * INTERVAL_UNIT_SECONDS[unit];
}

/**
 * Whether an interval is one the scheduler must refuse.
 *
 * A non-integer or non-positive count is refused by the same predicate: it is
 * not a shorter interval, it is not an interval at all, and the form and the
 * schema should say so with one message rather than two.
 */
export function isCakeIntervalTooShort(count: number, unit: CakeIntervalUnit): boolean {
  if (!Number.isInteger(count) || count < 1) return true;
  return cakeIntervalSeconds(count, unit) < CAKE_MINIMUM_INTERVAL_SECONDS;
}

/** A stored 0–23 hour as it reads on a clock face. 0 is 12 AM, 12 is 12 PM. */
export function to12Hour(hour24: number): {
  readonly hour12: number;
  readonly meridiem: CakeMeridiem;
} {
  const meridiem: CakeMeridiem = hour24 < 12 ? "AM" : "PM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return { hour12, meridiem };
}

/** A clock face back to the 0–23 hour the calendar arithmetic needs. */
export function to24Hour(hour12: number, meridiem: CakeMeridiem): number {
  const base = hour12 % 12;
  return meridiem === "AM" ? base : base + 12;
}

/**
 * The arithmetic that used to live here — `nextRunAfter` and its calendar
 * helpers — now lives in `@t3tools/shared/cakeSchedule`, which is where this
 * repo keeps runtime policy. What remains above is the wire shapes and the
 * derivations the schemas themselves need, because `contracts` cannot import
 * `shared`.
 */
