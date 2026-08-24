import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import { runCakeMigrations } from "./CakeMigrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { CakeRepository } from "./CakeRepository.ts";
import { CakeRepositoryLive } from "./CakeRepositoryLive.ts";
import {
  CakeTurnStartError,
  runCakeTickOnce,
  type CakeTurnStarter,
} from "./CakeScheduleReactor.ts";

/**
 * One tick, end to end, against a real database and a recording turn-starter.
 *
 * Deliberately a single tick rather than the running reactor: the repo forbids
 * sleep-based tests, and "did the timer fire" is the one thing about a
 * scheduler not worth asserting — `Effect.repeat` is not ours to test. What is
 * ours is what happens when a tick meets real rows.
 */

const layer = it.layer(CakeRepositoryLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())));

const NOW = "2026-03-10T09:00:30.000Z";

const sampleCake = (id: string) => ({
  id,
  name: `Cake ${id}`,
  providerKind: "claudeAgent",
  model: "claude-opus-5",
  effort: "high",
  schedule: {
    kind: "at" as const,
    cadence: "day" as const,
    hour: 9,
    meridiem: "AM" as const,
    timeZone: "UTC",
  },
  disallowedTools: [] as ReadonlyArray<string>,
  instructions: "# CAKE.md\n\nDo the loop.",
});

/** Records what the reactor asked for instead of starting a real agent. */
const recordingStarter = (
  started: Ref.Ref<ReadonlyArray<{ threadId: string; prompt: string }>>,
): CakeTurnStarter => ({
  // Nothing to resolve: this block has no orchestration layer, so a cake runs
  // where it is attached. `CakeScheduleReactor.dispatch.test.ts` is where the
  // resolution is driven through the real engine.
  resolveRunThread: (request) => Effect.succeed(request.threadId),
  startTurn: (input) =>
    Ref.update(started, (all) => [...all, { threadId: input.threadId, prompt: input.prompt }]),
});

layer("runCakeTickOnce", (it) => {
  /**
   * `it.layer` builds one in-memory database for the whole block, so each case
   * starts from empty tables. Without this, an attachment left by an earlier
   * test makes a later one fire a cake it never set up — the assertions then
   * depend on execution order rather than on behaviour.
   */
  const seed = Effect.gen(function* () {
    yield* runMigrations({});
    yield* runCakeMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM cake_runs`;
    yield* sql`DELETE FROM cake_thread_attachments`;
    yield* sql`DELETE FROM cakes`;
    const repo = yield* CakeRepository;
    yield* repo.upsert(sampleCake("cake-1"), NOW);
    return repo;
  });

  it.effect("starts a turn for a cake whose slot has arrived", () =>
    Effect.gen(function* () {
      const repo = yield* seed;
      yield* repo.attach(
        { cakeId: "cake-1", threadId: "thread-1", nextRunAt: "2026-03-10T09:00:00.000Z" },
        NOW,
      );
      const started = yield* Ref.make<ReadonlyArray<{ threadId: string; prompt: string }>>([]);

      yield* runCakeTickOnce({
        now: Date.parse(NOW),
        shouldRunOpportunisticWork: true,
        starter: recordingStarter(started),
      });

      const turns = yield* Ref.get(started);
      assert.equal(turns.length, 1);
      assert.equal(turns[0]?.threadId, "thread-1");
      assert.equal(turns[0]?.prompt, "# CAKE.md\n\nDo the loop.");
    }),
  );

  /**
   * The bug this guards is the one that matters most in a scheduler: a tick
   * that fires without moving the slot leaves the cake due, so the next tick
   * starts another turn on a thread already working, and so on.
   */
  it.effect("does not fire the same slot twice", () =>
    Effect.gen(function* () {
      const repo = yield* seed;
      yield* repo.attach(
        { cakeId: "cake-1", threadId: "thread-1", nextRunAt: "2026-03-10T09:00:00.000Z" },
        NOW,
      );
      const started = yield* Ref.make<ReadonlyArray<{ threadId: string; prompt: string }>>([]);
      const tick = runCakeTickOnce({
        now: Date.parse(NOW),
        shouldRunOpportunisticWork: true,
        starter: recordingStarter(started),
      });

      yield* tick;
      yield* tick;

      assert.equal((yield* Ref.get(started)).length, 1);
    }),
  );

  it.effect("starts nothing when the host is not accepting background work", () =>
    Effect.gen(function* () {
      const repo = yield* seed;
      yield* repo.attach(
        { cakeId: "cake-1", threadId: "thread-1", nextRunAt: "2026-03-10T09:00:00.000Z" },
        NOW,
      );
      const started = yield* Ref.make<ReadonlyArray<{ threadId: string; prompt: string }>>([]);

      yield* runCakeTickOnce({
        now: Date.parse(NOW),
        shouldRunOpportunisticWork: false,
        starter: recordingStarter(started),
      });

      assert.equal((yield* Ref.get(started)).length, 0);
    }),
  );

  /**
   * Deferring must not consume the slot. The whole point is that the run is
   * still owed once the machine is willing again.
   */
  it.effect("fires a deferred cake on the next willing tick", () =>
    Effect.gen(function* () {
      const repo = yield* seed;
      yield* repo.attach(
        { cakeId: "cake-1", threadId: "thread-1", nextRunAt: "2026-03-10T09:00:00.000Z" },
        NOW,
      );
      const started = yield* Ref.make<ReadonlyArray<{ threadId: string; prompt: string }>>([]);

      yield* runCakeTickOnce({
        now: Date.parse(NOW),
        shouldRunOpportunisticWork: false,
        starter: recordingStarter(started),
      });
      yield* runCakeTickOnce({
        now: Date.parse(NOW),
        shouldRunOpportunisticWork: true,
        starter: recordingStarter(started),
      });

      assert.equal((yield* Ref.get(started)).length, 1);
    }),
  );

  it.effect("records a missed slot without starting a turn", () =>
    Effect.gen(function* () {
      const repo = yield* seed;
      yield* repo.attach(
        { cakeId: "cake-1", threadId: "thread-1", nextRunAt: "2026-01-01T09:00:00.000Z" },
        NOW,
      );
      const started = yield* Ref.make<ReadonlyArray<{ threadId: string; prompt: string }>>([]);

      yield* runCakeTickOnce({
        now: Date.parse("2026-06-01T12:00:00.000Z"),
        shouldRunOpportunisticWork: true,
        starter: recordingStarter(started),
      });

      assert.equal((yield* Ref.get(started)).length, 0);
      const runs = yield* repo.listRuns("cake-1");
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.outcome, "missed");
    }),
  );

  it.effect("does nothing when no cake is attached anywhere", () =>
    Effect.gen(function* () {
      yield* seed;
      const started = yield* Ref.make<ReadonlyArray<{ threadId: string; prompt: string }>>([]);

      yield* runCakeTickOnce({
        now: Date.parse(NOW),
        shouldRunOpportunisticWork: true,
        starter: recordingStarter(started),
      });

      assert.equal((yield* Ref.get(started)).length, 0);
    }),
  );

  /**
   * One failing cake must not take the batch with it. A scheduler that stops at
   * the first error stops every other loop on the machine, and the failure is
   * silent because nobody is watching a background tick.
   */
  it.effect("keeps going when one cake's turn fails to start", () =>
    Effect.gen(function* () {
      const repo = yield* seed;
      yield* repo.upsert(sampleCake("cake-2"), NOW);
      yield* repo.attach(
        { cakeId: "cake-1", threadId: "boom", nextRunAt: "2026-03-10T09:00:00.000Z" },
        NOW,
      );
      yield* repo.attach(
        { cakeId: "cake-2", threadId: "fine", nextRunAt: "2026-03-10T09:00:00.000Z" },
        NOW,
      );
      const started = yield* Ref.make<ReadonlyArray<{ threadId: string; prompt: string }>>([]);

      yield* runCakeTickOnce({
        now: Date.parse(NOW),
        shouldRunOpportunisticWork: true,
        starter: {
          resolveRunThread: (request) => Effect.succeed(request.threadId),
          startTurn: (input) =>
            input.threadId === "boom"
              ? Effect.fail(
                  new CakeTurnStartError({
                    cakeId: input.cakeId,
                    threadId: input.threadId,
                    detail: "provider unavailable",
                  }),
                )
              : Ref.update(started, (all) => [
                  ...all,
                  { threadId: input.threadId, prompt: input.prompt },
                ]),
        },
      });

      assert.equal((yield* Ref.get(started)).length, 1);
    }),
  );
});
