import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  CakeAttachInput,
  CakeDetachInput,
  CakeRunNowInput,
  CakeSetEnabledInput,
  CakeUpsertInput,
} from "./cakeRpc.ts";

/**
 * The payloads a client may send about cakes.
 *
 * These are the boundary between a renderer and a scheduler that will act on
 * whatever crosses it, unattended. The assertions worth having are the refusals
 * — a payload this schema accepts is one the server will act on months later.
 */

const decodeUpsert = Schema.decodeUnknownSync(CakeUpsertInput);
const decodeAttach = Schema.decodeUnknownSync(CakeAttachInput);

const validCake = {
  id: "cake-1",
  name: "Nightly triage",
  providerKind: "claudeAgent",
  model: "claude-opus-5",
  effort: "high",
  schedule: {
    kind: "at",
    cadence: "day",
    hour: 9,
    meridiem: "AM",
    timeZone: "America/New_York",
  },
  disallowedTools: [],
  instructions: "# CAKE.md\n\nTriage.",
};

describe("CakeUpsertInput", () => {
  it("accepts a complete cake", () => {
    expect(decodeUpsert({ cake: validCake }).cake.id).toBe("cake-1");
  });

  it("accepts an interval schedule at or above the floor", () => {
    const cake = decodeUpsert({
      cake: { ...validCake, schedule: { kind: "every", count: 19, unit: "minute" } },
    }).cake;
    expect(cake.schedule.kind).toBe("every");
  });

  /**
   * An hour outside the clock face is not a schedule, it is a cake that never
   * fires or fires at a time nobody chose. The renderer's picker cannot produce
   * one, but the renderer is not the only thing that can call this.
   */
  it("rejects an hour off the clock face", () => {
    expect(() =>
      decodeUpsert({ cake: { ...validCake, schedule: { ...validCake.schedule, hour: 13 } } }),
    ).toThrow();
    expect(() =>
      decodeUpsert({ cake: { ...validCake, schedule: { ...validCake.schedule, hour: 0 } } }),
    ).toThrow();
  });

  it("rejects an unknown meridiem", () => {
    expect(() =>
      decodeUpsert({ cake: { ...validCake, schedule: { ...validCake.schedule, meridiem: "am" } } }),
    ).toThrow();
  });

  it("rejects an unknown cadence", () => {
    expect(() =>
      decodeUpsert({
        cake: { ...validCake, schedule: { ...validCake.schedule, cadence: "fortnightly" } },
      }),
    ).toThrow();
  });

  /**
   * The refusal with teeth. A cake spawns a full-access agent unattended, so
   * `every 1 second` is a fork bomb — and the scheduler ticks every 30 seconds,
   * so it could not honour the cadence even if the machine survived it. The
   * boundary is checked on both sides because an off-by-one here is the
   * difference between a refusal and a fork bomb.
   */
  it("rejects an interval under sixty seconds and accepts exactly sixty", () => {
    expect(() =>
      decodeUpsert({
        cake: { ...validCake, schedule: { kind: "every", count: 59, unit: "second" } },
      }),
    ).toThrow();
    expect(
      decodeUpsert({
        cake: { ...validCake, schedule: { kind: "every", count: 60, unit: "second" } },
      }).cake.schedule.kind,
    ).toBe("every");
    expect(() =>
      decodeUpsert({
        cake: { ...validCake, schedule: { kind: "every", count: 1, unit: "second" } },
      }),
    ).toThrow();
  });

  it("rejects an interval with no periods in it", () => {
    expect(() =>
      decodeUpsert({
        cake: { ...validCake, schedule: { kind: "every", count: 0, unit: "hour" } },
      }),
    ).toThrow();
  });

  it("rejects a cake with no instructions to run", () => {
    expect(() => decodeUpsert({ cake: { ...validCake, instructions: "  " } })).toThrow();
  });
});

describe("CakeAttachInput", () => {
  it("accepts a cake and the thread it runs on", () => {
    const input = decodeAttach({ cakeId: "cake-1", threadId: "thread-1" });
    expect(input.cakeId).toBe("cake-1");
    expect(input.threadId).toBe("thread-1");
  });

  it("rejects a blank thread", () => {
    expect(() => decodeAttach({ cakeId: "cake-1", threadId: "  " })).toThrow();
  });
});

describe("the remaining cake payloads", () => {
  it("detach names both sides", () => {
    const decode = Schema.decodeUnknownSync(CakeDetachInput);
    const input = decode({ cakeId: "cake-1", threadId: "thread-1" });
    expect(input.threadId).toBe("thread-1");
  });

  /**
   * The composer's toggle sends this. It carries the thread as well as the
   * cake because a cake can be attached to several threads and only one of
   * them is being switched off.
   */
  it("setEnabled is scoped to one attachment, not to the cake", () => {
    const decode = Schema.decodeUnknownSync(CakeSetEnabledInput);
    const input = decode({ cakeId: "cake-1", threadId: "thread-1", enabled: false });
    expect(input.threadId).toBe("thread-1");
    expect(input.enabled).toBe(false);
  });

  it("runNow names the attachment to fire", () => {
    const decode = Schema.decodeUnknownSync(CakeRunNowInput);
    const input = decode({ cakeId: "cake-1", threadId: "thread-1" });
    expect(input.cakeId).toBe("cake-1");
  });

  /**
   * A plain run-now must not read as "tear the session down". Every caller
   * except the drop dialog's stop-and-spawn answer omits the flag, and a
   * decoded `true` there would end a session somebody is still working in.
   */
  it("runNow leaves the session alone unless the caller asks", () => {
    const decode = Schema.decodeUnknownSync(CakeRunNowInput);
    expect(decode({ cakeId: "cake-1", threadId: "thread-1" }).endSessionFirst).toBeUndefined();
    expect(
      decode({ cakeId: "cake-1", threadId: "thread-1", endSessionFirst: true }).endSessionFirst,
    ).toBe(true);
  });
});
