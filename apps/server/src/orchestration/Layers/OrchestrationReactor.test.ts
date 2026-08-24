import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import { OrchestrationReactor } from "../Services/OrchestrationReactor.ts";
import { makeOrchestrationReactor } from "./OrchestrationReactor.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";
import { CakeScheduleReactor } from "../../cakes/CakeScheduleReactor.ts";

/**
 * Which long-running roots the server actually starts.
 *
 * This is the test the cake scheduler needed and did not have. Every part of it
 * — the schedule maths, the tick, the run target, the run/turn join — was
 * correct and covered for a release in which no cake ever fired, because the
 * layer that turns the crank had no caller and nothing asserted that the server
 * had one. A unit test of the tick cannot see that; only a test of the
 * composition can.
 */

describe("OrchestrationReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<OrchestrationReactor, never> | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  it("starts provider ingestion, provider command, checkpoint, thread deletion, awareness, and cake schedule reactors", async () => {
    const started: string[] = [];

    runtime = ManagedRuntime.make(
      Layer.effect(OrchestrationReactor, makeOrchestrationReactor).pipe(
        Layer.provideMerge(
          Layer.succeed(ProviderRuntimeIngestionService, {
            start: () => {
              started.push("provider-runtime-ingestion");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ProviderCommandReactor, {
            start: () => {
              started.push("provider-command-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(CheckpointReactor, {
            start: () => {
              started.push("checkpoint-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ThreadDeletionReactor, {
            start: () => {
              started.push("thread-deletion-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(AgentAwarenessRelay.AgentAwarenessRelay, {
            publishThread: () => Effect.void,
            start: () => {
              started.push("agent-awareness-relay");
              return Effect.void;
            },
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(CakeScheduleReactor, {
            start: () => {
              started.push("cake-schedule-reactor");
              return Effect.void;
            },
          }),
        ),
      ),
    );

    const reactor = await runtime!.runPromise(Effect.service(OrchestrationReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));

    expect(started).toEqual([
      "provider-runtime-ingestion",
      "provider-command-reactor",
      "checkpoint-reactor",
      "thread-deletion-reactor",
      "agent-awareness-relay",
      "cake-schedule-reactor",
    ]);

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});
