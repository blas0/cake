import {
  CommandId,
  OrchestrationDispatchCommandError,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CakeRepository } from "./CakeRepository.ts";
import { resolveCakeRunThread } from "./cakeRunThread.ts";
import { CakeTurnStartError, type CakeTurnStarter } from "./CakeScheduleReactor.ts";
import { watchThreadSessionStopped } from "./cakeSessionStopWatch.ts";
import { dispatchCakeTurn } from "./cakeTurnCommand.ts";

/**
 * The one construction of a cake's turn starter.
 *
 * There used to be two: one inside `ws.ts`, reachable only by the RPC handlers,
 * and one that would have had to be written again for the scheduler because a
 * layer cannot reach into a closure in the WebSocket layer. That second copy is
 * why the scheduler was never wired at all — and where two copies did exist
 * (the turn command, the run-target resolution) the tested copy kept passing
 * while the copy the server ran drifted. So this is an effect over services
 * rather than a closure over locals: the scheduler layer and the RPC handlers
 * both build it from the same context, and there is nothing left to drift.
 */

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

export interface CakeTurnStarterOptions {
  /**
   * End the thread's provider session before the cake's turn starts.
   *
   * Per call, never per server: the drop dialog's "stop the current agent, and
   * spawn the cake" answer says true, and the composer's Start button and the
   * scheduler both say false. Held once for the whole server it would be
   * global, and every Start press would tear down a session someone is working
   * in.
   */
  readonly endSessionFirst: boolean;
}

export type CakeTurnStarterFactory = (options: CakeTurnStarterOptions) => CakeTurnStarter;

export const makeCakeTurnStarterFactory: Effect.Effect<
  CakeTurnStarterFactory,
  never,
  | OrchestrationEngineService
  | ProjectionSnapshotQuery
  | CakeRepository
  | SqlClient.SqlClient
  | Crypto.Crypto
> = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const cakeRepository = yield* CakeRepository;
  // The repository leaks `SqlClient` on purpose (see its `@effect-expect-leaking`
  // note) and a `CakeTurnStarter` is a plain record handed to the tick, so
  // nothing provides it a context at call time. The client is captured here
  // instead, which is what `ws.ts` did for the same reason.
  const sqlClient = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
    isOrchestrationDispatchCommandError(cause)
      ? cause
      : new OrchestrationDispatchCommandError({
          message: cause instanceof Error ? cause.message : fallbackMessage,
          cause,
        });

  const randomUUID = crypto.randomUUIDv4.pipe(
    Effect.mapError((cause) =>
      toDispatchCommandError(cause, "Failed to generate orchestration command identifier."),
    ),
  );

  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

  /**
   * Straight to the engine, with none of the wrapping `ws.ts` puts around a
   * client's command.
   *
   * The bootstrap branch of that wrapper only ever runs for a
   * `thread.turn.start` carrying `bootstrap`, which is a field the composer
   * sets and `buildCakeTurnCommand` never does. The startup command queue is
   * the other half: it holds a command until the runtime accepts commands, and
   * every path into this one is already past that point — RPC handlers sit
   * behind the command-readiness middleware, and the scheduler's tick is parked
   * at the activation boundary that immediately precedes readiness. Depending
   * on it here would also be a layer cycle, since the startup service is built
   * on top of the runtime the scheduler lives in.
   */
  const dispatch = (command: OrchestrationCommand) =>
    orchestrationEngine
      .dispatch(command)
      .pipe(
        Effect.mapError((cause) =>
          toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
        ),
      );

  return (options) => ({
    /**
     * Where the cake's turn can actually run. The decision and the fork are
     * `resolveCakeRunThread`'s: everything here is the IO it needs, so the
     * version the server runs is the version the cake tests drive.
     */
    resolveRunThread: (request) =>
      resolveCakeRunThread<OrchestrationDispatchCommandError, never>(request, {
        readThread: (threadId) =>
          projectionSnapshotQuery.getThreadDetailById(ThreadId.make(threadId)).pipe(
            Effect.map(
              Option.match({
                onNone: () => null,
                onSome: (thread) => ({
                  // The guard this mirrors asks exactly this: a thread with a
                  // session has already told a provider something, and that is
                  // the point past which its model is fixed.
                  hasStartedConversation: thread.session !== null,
                  modelSelection: {
                    // The live session's instance wins over the thread's stored
                    // selection, the way the composer's own model picker
                    // resolves it: the selection can already name the instance a
                    // turn is about to move to.
                    instanceId: String(
                      thread.session?.providerInstanceId ?? thread.modelSelection.instanceId,
                    ),
                    model: thread.modelSelection.model,
                  },
                  projectId: String(thread.projectId),
                  branch: thread.branch,
                  worktreePath: thread.worktreePath,
                }),
              }),
            ),
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to read the cake's attached thread."),
            ),
          ),
        dispatch,
        attachCake: ({ cakeId, threadId }) =>
          Effect.flatMap(nowIso, (timestamp) =>
            // No next run of its own. The schedule belongs to the attachment the
            // user made; a second scheduled attachment would fire this cake
            // twice per slot.
            cakeRepository.attach({ cakeId, threadId, nextRunAt: null }, timestamp),
          ).pipe(
            Effect.provideService(SqlClient.SqlClient, sqlClient),
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to attach the cake to its forked thread."),
            ),
          ),
        newThreadId: randomUUID.pipe(Effect.map((uuid) => `thread-cake-${uuid}`)),
        newCommandId: (label) => serverCommandId(label),
        now: nowIso,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new CakeTurnStartError({
              cakeId: request.cakeId,
              threadId: request.threadId,
              detail: "resolving where the scheduled turn should run failed",
              cause,
            }),
        ),
      ),
    startTurn: (turn) =>
      Effect.gen(function* () {
        const createdAt = yield* nowIso;
        const commandId = yield* serverCommandId("cake-turn-start");
        const sessionStopCommandId = yield* serverCommandId("cake-session-stop");
        // Sequenced inside `dispatchCakeTurn` so the order the server really
        // sends in is the order the cake tests can hold.
        //
        // A scheduled cake asks for no session stop: it either runs in the
        // thread it is attached to or in one created for it, and both are
        // sessions it may keep. The drop dialog's stop-and-spawn answer is the
        // caller that does ask — and for it the stop must have *taken effect*
        // before the turn starts, not merely have been dispatched first,
        // because it is handled asynchronously and a late stop clears the
        // pending turn row the cake's active-turn lookup joins on.
        yield* dispatchCakeTurn<OrchestrationDispatchCommandError, Scope.Scope>(
          {
            turn,
            commandId,
            sessionStopCommandId,
            now: createdAt,
            endSessionFirst: options.endSessionFirst,
          },
          {
            dispatch,
            watchSessionStopped: (threadId) =>
              watchThreadSessionStopped(orchestrationEngine, threadId),
          },
        );
        // Scoped here so the watch's subscription is released with the turn
        // that opened it rather than living as long as the server.
      }).pipe(
        Effect.scoped,
        // The tick logs and swallows this so one bad cake cannot stop the
        // schedule. Narrowing to the tagged error here keeps that branch from
        // also catching unrelated defects and reporting them as a cake that
        // failed to start.
        Effect.mapError(
          (cause) =>
            new CakeTurnStartError({
              cakeId: turn.cakeId,
              threadId: turn.threadId,
              detail: "dispatching the scheduled turn failed",
              cause,
            }),
        ),
      ),
  });
});
