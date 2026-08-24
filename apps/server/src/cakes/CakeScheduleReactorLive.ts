import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { BackgroundPolicy } from "../background/BackgroundPolicy.ts";
import { forkParked } from "../serverActivation.ts";
import { CakeRepository } from "./CakeRepository.ts";
import { CakeRepositoryLive } from "./CakeRepositoryLive.ts";
import {
  CakeScheduleReactor,
  runCakeTickOnce,
  type CakeScheduleReactorShape,
} from "./CakeScheduleReactor.ts";
import { makeCakeTurnStarterFactory } from "./cakeTurnStarter.ts";

/**
 * The timer the whole feature rests on.
 *
 * Everything below this — the schedule maths, the tick decisions, the run
 * target, the run/turn join — was correct and tested for a release in which no
 * cake ever fired on its own, because nothing turned the crank. That is the
 * failure this file exists to make impossible: `OrchestrationReactor` yields
 * this service and calls `start()`, so leaving the layer out of the server's
 * composition is a type error rather than a feature that silently does nothing.
 */

/**
 * How often the schedule is examined, not how often a cake runs.
 *
 * A tick only asks the database which slots are due, so the interval is the
 * worst-case lateness of a run rather than a cost per cake. Half a minute keeps
 * that lateness invisible next to the shortest schedule a cake can be given.
 */
export const DEFAULT_TICK_INTERVAL_MS = 30_000;

export interface CakeScheduleReactorOptions {
  readonly tickIntervalMs?: number;
}

export const make = (options?: CakeScheduleReactorOptions) =>
  Effect.gen(function* () {
    const backgroundPolicy = yield* BackgroundPolicy;
    const starterFor = yield* makeCakeTurnStarterFactory;
    // Captured rather than left in the tick's requirements, because `start`
    // hands the tick to a fiber that outlives this effect: its context is
    // whatever it was forked with, and the repository's leaked `SqlClient` is
    // not something a `Scope`-only signature can carry.
    const cakeRepository = yield* CakeRepository;
    const sqlClient = yield* SqlClient.SqlClient;
    const tickIntervalMs = Math.max(1, options?.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);

    /**
     * One starter for every scheduled run, which is safe only because the
     * scheduler's answer never varies: a cake fires either in the thread it is
     * attached to or in one created for it, and both are sessions it may keep.
     * The caller that does end a session first — the drop dialog — asks for its
     * own starter per call.
     */
    const starter = starterFor({ endSessionFirst: false });

    const tick = Effect.gen(function* () {
      const [now, policy] = yield* Effect.all([Clock.currentTimeMillis, backgroundPolicy.snapshot]);
      yield* runCakeTickOnce({
        now,
        shouldRunOpportunisticWork: policy.shouldRunOpportunisticWork,
        starter,
      });
    }).pipe(
      Effect.provideService(CakeRepository, cakeRepository),
      Effect.provideService(SqlClient.SqlClient, sqlClient),
    );

    const start: CakeScheduleReactorShape["start"] = Effect.fn("start")(function* () {
      yield* forkParked(
        tick.pipe(
          // Swallowed and logged per tick, not per cake: `runCakeTickOnce`
          // already survives one bad cake, so anything reaching here is the
          // read of the schedule itself failing, and a scheduler that dies on
          // one bad database read never runs again.
          Effect.catch((error) => Effect.logWarning("cake schedule tick failed", { error })),
          Effect.repeat(Schedule.spaced(Duration.millis(tickIntervalMs))),
        ),
      );
    });

    return { start } satisfies CakeScheduleReactorShape;
  });

export const makeCakeScheduleReactorLive = (options?: CakeScheduleReactorOptions) =>
  Layer.effect(CakeScheduleReactor, make(options)).pipe(
    // Provided here rather than added to the server's dependency stack: the
    // repository is a plain `Layer.succeed` over the shared `SqlClient`, and
    // the scheduler is the only root outside the WebSocket layer that reads it.
    Layer.provide(CakeRepositoryLive),
  );

export const CakeScheduleReactorLive = makeCakeScheduleReactorLive();
