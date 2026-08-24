import { describe, expect, it } from "vite-plus/test";

import * as Schema from "effect/Schema";

import { CakeConfig, type CakeSchedule } from "@t3tools/contracts";

import {
  cakeAttachmentKey,
  cakeTurnMessageId,
  planCakeTickEffects,
  type CakeTickPlan,
} from "./applyCakeTick.ts";
import type { CakeTickDecision } from "./cakeTick.ts";

/**
 * What a tick's decisions turn into: writes, and turns to start.
 *
 * Kept pure and separate from the reactor for the same reason the decision is —
 * the reactor should be the only part that touches a database or a queue, and
 * everything worth asserting happens before it does. This layer answers "given
 * these decisions, what should happen", which is where the mistakes that matter
 * live: firing without advancing the slot, recording a run that never ran,
 * writing anything at all on a machine that asked for quiet.
 */

const schedule: CakeSchedule = {
  kind: "at",
  cadence: "day",
  hour: 9,
  meridiem: "AM",
  timeZone: "UTC",
};

/**
 * Decoded rather than cast. The branded fields (`CakeId`, `ProviderDriverKind`)
 * are the whole point of the contract, and an `as CakeConfig` asserts them into
 * existence without ever running the checks the scheduler relies on — so a
 * fixture that the real API would reject could still pass every test here.
 */
const cake = Schema.decodeUnknownSync(CakeConfig)({
  id: "cake-1",
  name: "Nightly triage",
  providerKind: "claudeAgent",
  model: "claude-opus-5",
  effort: "high",
  schedule,
  disallowedTools: [],
  instructions: "# CAKE.md\n\nTriage the inbox.",
});

const at = (iso: string): number => Date.parse(iso);

const plan = (decisions: ReadonlyArray<CakeTickDecision>): CakeTickPlan =>
  planCakeTickEffects({
    decisions,
    cakesById: new Map([["cake-1", cake]]),
    now: at("2026-03-10T09:00:30.000Z"),
  });

const fire: CakeTickDecision = {
  kind: "fire",
  cakeId: "cake-1",
  threadId: "thread-1",
  scheduledFor: at("2026-03-10T09:00:00.000Z"),
  nextRunAt: at("2026-03-11T09:00:00.000Z"),
};

const missed: CakeTickDecision = {
  kind: "skip-missed",
  cakeId: "cake-1",
  threadId: "thread-1",
  scheduledFor: at("2026-01-01T09:00:00.000Z"),
  nextRunAt: at("2026-03-11T09:00:00.000Z"),
};

const deferred: CakeTickDecision = {
  kind: "defer",
  cakeId: "cake-1",
  threadId: "thread-1",
  reason: "the host is not accepting background work right now",
};

describe("planCakeTickEffects — firing", () => {
  it("starts exactly one turn per fired cake", () => {
    expect(plan([fire]).turns).toHaveLength(1);
  });

  /**
   * CAKE.md is the turn. Every provider gets the same text, so a loop behaves
   * identically wherever it runs and the instructions are visible in the
   * transcript rather than hidden in a system prompt nobody can read back.
   */
  it("sends CAKE.md as the prompt", () => {
    expect(plan([fire]).turns[0]?.prompt).toBe(cake.instructions);
  });

  it("starts the turn on the thread the cake is attached to", () => {
    expect(plan([fire]).turns[0]?.threadId).toBe("thread-1");
  });

  /**
   * Advancing the slot is not bookkeeping that can happen later. If a tick
   * fires and the slot stays put, the very next tick sees the same cake as due
   * and starts a second turn on a thread already working.
   */
  it("advances the slot in the same plan that fires it", () => {
    const advanced = plan([fire]).slotUpdates;
    expect(advanced).toHaveLength(1);
    expect(advanced[0]?.nextRunAt).toBe(at("2026-03-11T09:00:00.000Z"));
  });

  it("records the run it started", () => {
    const runs = plan([fire]).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.outcome).toBe("started");
  });

  it("carries the cake's own model and effort onto the turn", () => {
    const turn = plan([fire]).turns[0];
    expect(turn?.model).toBe("claude-opus-5");
    expect(turn?.effort).toBe("high");
  });

  /**
   * A cake whose attached thread could not host it runs in a thread created for
   * it, and both the turn and the run must name that thread. They are the two
   * sides of the join that lights "Stop Cake": a run recorded against the
   * attachment while the turn starts elsewhere is a run permanently unlinked
   * from the turn it caused, and nothing errors to say so.
   */
  it("sends the turn and its run to the thread the cake really runs in", () => {
    const forked = planCakeTickEffects({
      decisions: [fire],
      cakesById: new Map([["cake-1", cake]]),
      runThreads: new Map([
        [cakeAttachmentKey({ cakeId: "cake-1", threadId: "thread-1" }), "thread-forked"],
      ]),
      now: at("2026-03-10T09:00:30.000Z"),
    });

    expect(forked.turns[0]?.threadId).toBe("thread-forked");
    expect(forked.runs[0]?.threadId).toBe("thread-forked");
    expect(forked.runs[0]?.turnMessageId).toBe(forked.turns[0]?.messageId);
  });

  /**
   * The slot stays on the attachment the user made, whichever thread the run
   * lands in. Advancing a slot that does not exist would leave the real
   * attachment due, and the very next tick would fire it again.
   */
  it("advances the attached thread's slot even when the run is forked away", () => {
    const forked = planCakeTickEffects({
      decisions: [fire],
      cakesById: new Map([["cake-1", cake]]),
      runThreads: new Map([
        [cakeAttachmentKey({ cakeId: "cake-1", threadId: "thread-1" }), "thread-forked"],
      ]),
      now: at("2026-03-10T09:00:30.000Z"),
    });

    expect(forked.slotUpdates[0]?.threadId).toBe("thread-1");
  });
});

describe("planCakeTickEffects — missed", () => {
  it("starts no turn for a missed slot", () => {
    expect(plan([missed]).turns).toEqual([]);
  });

  it("records the miss so a silent loop is distinguishable from a broken one", () => {
    const runs = plan([missed]).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.outcome).toBe("missed");
  });

  it("still advances the slot, or the miss repeats every tick", () => {
    expect(plan([missed]).slotUpdates).toHaveLength(1);
  });
});

describe("planCakeTickEffects — deferred", () => {
  /**
   * A defer must be inert. The host asked for quiet, and a plan that recorded
   * something would be doing exactly the work the defer exists to avoid — and
   * a plan that advanced the slot would turn the defer into a lost run.
   */
  it("does nothing at all", () => {
    const planned = plan([deferred]);
    expect(planned.turns).toEqual([]);
    expect(planned.runs).toEqual([]);
    expect(planned.slotUpdates).toEqual([]);
  });
});

describe("planCakeTickEffects — a cake that vanished", () => {
  /**
   * A cake can be deleted between the due query and the tick. Attachments
   * cascade, so this is a narrow race rather than a normal state — but a
   * scheduler that threw here would stop firing every other cake in the batch.
   */
  it("skips a decision whose cake is gone rather than failing the tick", () => {
    const planned = planCakeTickEffects({
      decisions: [fire],
      cakesById: new Map(),
      now: at("2026-03-10T09:00:30.000Z"),
    });

    expect(planned.turns).toEqual([]);
    expect(planned.runs).toEqual([]);
  });

  it("still decides the cakes that do exist", () => {
    const planned = planCakeTickEffects({
      decisions: [{ ...fire, cakeId: "ghost" }, fire],
      cakesById: new Map([["cake-1", cake]]),
      now: at("2026-03-10T09:00:30.000Z"),
    });

    expect(planned.turns).toHaveLength(1);
  });
});

describe("planCakeTickEffects — batches", () => {
  it("plans every decision in one pass", () => {
    const planned = plan([fire, missed, deferred]);
    expect(planned.turns).toHaveLength(1);
    expect(planned.runs).toHaveLength(2);
    expect(planned.slotUpdates).toHaveLength(2);
  });
});

/**
 * The id that ties a run to the turn it started.
 *
 * It is written twice — onto the dispatched turn and onto the `cake_runs` row —
 * and the "which cake owns this thread's active turn" lookup only works while
 * those two agree. Nothing else asserts this derivation, so a mutation that
 * dropped a field from it survived the whole suite: every existing test uses a
 * single run, and one run cannot collide with itself.
 */
describe("cakeTurnMessageId", () => {
  const base = { cakeId: "cake-1", threadId: "thread-1", scheduledFor: 1_700_000_000_000 };

  /**
   * The case the surviving mutant exposed. Two slots of the same cake on the
   * same thread are different runs, and a shared id would make the second run
   * indistinguishable from the first — so a lookup during today's run could
   * name a turn that finished yesterday.
   */
  it("gives successive slots of one cake distinct ids", () => {
    expect(cakeTurnMessageId(base)).not.toBe(
      cakeTurnMessageId({ ...base, scheduledFor: base.scheduledFor + 86_400_000 }),
    );
  });

  it("gives two cakes on one thread distinct ids", () => {
    expect(cakeTurnMessageId(base)).not.toBe(cakeTurnMessageId({ ...base, cakeId: "cake-2" }));
  });

  /**
   * A cake attached to several threads fires once per thread on the same slot.
   * Those runs are concurrent, so a shared id would collide live rather than
   * across time.
   */
  it("gives one cake on two threads distinct ids", () => {
    expect(cakeTurnMessageId(base)).not.toBe(cakeTurnMessageId({ ...base, threadId: "thread-2" }));
  });

  /**
   * The property the join actually depends on: the value is a function of the
   * slot alone, so the writer of the turn and the writer of the run compute the
   * same string without sharing state.
   */
  it("is stable for the same slot, so both writers agree", () => {
    expect(cakeTurnMessageId(base)).toBe(cakeTurnMessageId({ ...base }));
  });
});
