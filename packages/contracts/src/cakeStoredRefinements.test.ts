import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { CakeConfig } from "./cakes.ts";
import { CakeSchedule } from "./cakeSchedule.ts";

/**
 * What a *stored* cake is allowed to be.
 *
 * The input schemas in `cakeRpc.ts` already refuse out-of-range values, and
 * their own doc comment calls those bounds "refusals rather than hints". The
 * stored schemas did not, which made the refusals a property of one doorway
 * rather than of the data: anything decoded back out of SQLite — the path every
 * scheduler tick takes — was range-unchecked, and `nextFixedIntervalSlot` grew
 * a defensive runtime clamp to survive it.
 *
 * A schedule decides when a full-access agent runs unattended. The interesting
 * assertions are all refusals.
 */

const decodeSchedule = Schema.decodeUnknownSync(CakeSchedule);
const decodeCake = Schema.decodeUnknownSync(CakeConfig);

const interval = (count: unknown) => ({ kind: "every", count, unit: "hour" });
const anchored = (over: Record<string, unknown>) => ({
  kind: "at",
  cadence: "day",
  hour: 9,
  meridiem: "AM",
  timeZone: "America/New_York",
  ...over,
});

const cake = (over: Record<string, unknown> = {}) => ({
  id: "cake_1",
  name: "Nightly triage",
  providerKind: "claudeAgent",
  model: "claude-opus-5",
  effort: "high",
  schedule: { kind: "every", count: 1, unit: "hour" },
  disallowedTools: [],
  instructions: "Check the open pull requests.",
  ...over,
});

describe("a stored cake's effort", () => {
  /**
   * Load-bearing, and the reason `effort` is not simply `TrimmedNonEmptyString`
   * like its siblings. `cakeTurnCommand` branches on `effort.length > 0` and
   * sends *no* effort option when it is empty — which is how a cake says "use
   * whatever this provider defaults to", and the only thing a model with no
   * effort ladder can say. Refusing "" would make such a cake unsaveable.
   */
  it("accepts empty as the provider's own default", () => {
    expect(decodeCake(cake({ effort: "" })).effort).toBe("");
  });

  it("accepts a real effort", () => {
    expect(decodeCake(cake({ effort: "high" })).effort).toBe("high");
  });

  /**
   * The case between the two that is nobody's intent. `"  "` has length > 0, so
   * it is sent as an effort option whose value is whitespace — which no adapter
   * recognises and every adapter drops in silence. The cake then runs at a
   * different effort than its form displays, and nothing reports it.
   */
  it("refuses whitespace, which is neither a default nor an effort", () => {
    expect(() => decodeCake(cake({ effort: "   " }))).toThrow();
  });
});

describe("a stored interval schedule", () => {
  it("accepts a whole positive count", () => {
    expect(decodeSchedule(interval(6))).toMatchObject({ count: 6 });
  });

  /** `every 0 hours` is not a cadence; it is a division by zero with a UI. */
  it("refuses a zero count", () => {
    expect(() => decodeSchedule(interval(0))).toThrow();
  });

  it("refuses a negative count", () => {
    expect(() => decodeSchedule(interval(-3))).toThrow();
  });

  /** Half an hour is expressible as `30 minutes`; `0.5 hours` is a bug. */
  it("refuses a fractional count", () => {
    expect(() => decodeSchedule(interval(2.5))).toThrow();
  });
});

describe("a stored anchored schedule", () => {
  it("accepts an hour on the clock face", () => {
    expect(decodeSchedule(anchored({ hour: 12 }))).toMatchObject({ hour: 12 });
  });

  /** The field is documented "1–12, as it reads on a clock face". */
  it("refuses an hour below one", () => {
    expect(() => decodeSchedule(anchored({ hour: 0 }))).toThrow();
  });

  it("refuses an hour above twelve", () => {
    expect(() => decodeSchedule(anchored({ hour: 13 }))).toThrow();
  });

  it("refuses a fractional hour", () => {
    expect(() => decodeSchedule(anchored({ hour: 9.5 }))).toThrow();
  });
});

describe("a stored schedule's time zone", () => {
  it("accepts an IANA zone", () => {
    expect(decodeSchedule(anchored({ timeZone: "Europe/London" }))).toMatchObject({
      timeZone: "Europe/London",
    });
  });

  /**
   * The field's own comment says "An IANA zone such as `America/New_York`.
   * Never an offset." Nothing enforced either half, so an offset validated fine
   * here and failed months later inside `DateTime.makeZonedUnsafe`, on a
   * scheduler tick, at whatever hour the cake was due — as far from the write
   * that caused it as it is possible to get.
   */
  it("refuses a UTC offset, which the comment already forbids", () => {
    expect(() => decodeSchedule(anchored({ timeZone: "+05:30" }))).toThrow();
  });

  it("refuses a zone nobody has heard of", () => {
    expect(() => decodeSchedule(anchored({ timeZone: "Mars/Olympus_Mons" }))).toThrow();
  });
});

/**
 * The check that matters most and is easiest to skip. Refinements added after
 * rows exist are a migration whether or not anyone calls them one.
 */
describe("rows written before these refinements existed", () => {
  it("still decode", () => {
    expect(() =>
      decodeCake(cake({ effort: "high", schedule: { kind: "every", count: 1, unit: "hour" } })),
    ).not.toThrow();
  });

  it("still decode an anchored row", () => {
    expect(() => decodeCake(cake({ schedule: anchored({}) }))).not.toThrow();
  });
});
