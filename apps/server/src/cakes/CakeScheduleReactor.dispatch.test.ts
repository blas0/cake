import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { CakeRepository, type CakeRepositoryShape } from "./CakeRepository.ts";
import { CakeRepositoryLive } from "./CakeRepositoryLive.ts";
import { runCakeNow } from "./cakeRunNow.ts";
import { resolveCakeRunThread } from "./cakeRunThread.ts";
import { dispatchCakeTurn } from "./cakeTurnCommand.ts";
import {
  CakeTurnStartError,
  runCakeTickOnce,
  type CakeTurnStarter,
} from "./CakeScheduleReactor.ts";

/**
 * A cake's turn, taken through the orchestration pipeline it really uses, and
 * then looked up the way the UI looks it up.
 *
 * `CakeRepository.test.ts` already proves the join reads hand-written
 * `projection_turns` and `projection_thread_sessions` rows correctly. What it
 * cannot prove is that the rows the pipeline actually writes look like the ones
 * it was handed: the message id travels from the tick's planner, through
 * `thread.turn.start`, through the decider's `thread.message-sent` /
 * `thread.turn-start-requested` pair, and into `pending_message_id` — and if
 * any step along the way substitutes an id of its own, every hand-seeded test
 * still passes while "Stop Cake" never lights in production.
 *
 * So the database here is the real schema, the engine is the real engine, and
 * the only stand-in is the provider: instead of a runtime reporting a session,
 * the test dispatches the `thread.session.set` command the runtime ingestion
 * would dispatch, with the same shape.
 */

const TestLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    // Merged rather than only provided: the run-target resolution reads the
    // thread through the same snapshot query `ws.ts` hands it, so the test has
    // to be able to reach it too.
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  CakeRepositoryLive,
).pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-cake-dispatch-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const layer = it.layer(TestLayer);

const NOW = "2026-03-10T09:00:30.000Z";
const SLOT = "2026-03-10T09:00:00.000Z";
/** When the stand-in provider command reactor reports the session stopped. */
const STOP_SETTLED_AT = "2026-03-10T09:00:30.500Z";
/**
 * Comfortably past every event this file writes, so the stand-in reactor below
 * reads the whole log rather than a default page of it.
 */
const EVENT_READ_LIMIT = 10_000;

const sampleCake = (id: string) => ({
  id,
  name: `Cake ${id}`,
  providerKind: "codex",
  model: "gpt-5-codex",
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

/**
 * The turn starter `ws.ts` wires into the reactor, minus the WebSocket world it
 * is defined inside.
 *
 * The dispatch is driven by the same `dispatchCakeTurn` the server calls, not
 * by a copy of it. A copy would keep passing while `ws.ts` drifted, and the
 * drifts that matter are silent: minting a fresh message id instead of
 * carrying the planner's breaks the join below without breaking anything else,
 * and starting the turn before the session stop has taken effect discards the
 * session the turn just resumed and unlinks the run from its turn.
 *
 * `settleSessionStop` stands in for the provider command reactor: awaiting it
 * is the point at which the thread's session really reaches "stopped".
 */
/**
 * The providers this block's builds knows about.
 *
 * Grok is the one provider in the tree that refuses a model change after a
 * conversation has started, and it is the reason the derived run target exists
 * at all. Codex is here as the ordinary case: it has no opinion, so a cake
 * pointed at it runs wherever it is attached.
 */
const PROVIDERS: ReadonlyArray<{
  readonly instanceId: string;
  readonly requiresNewThreadForModelChange?: boolean;
}> = [{ instanceId: "codex" }, { instanceId: "grok", requiresNewThreadForModelChange: true }];

/**
 * The id the fork path mints, derived from the attached thread so the
 * assertions can name it.
 *
 * Per case rather than a single constant: the engine dedupes on command
 * receipts, so a shared thread id would make the second case's `thread.create`
 * a replay of the first's and silently hand it the earlier case's thread.
 */
const forkedThreadIdFor = (threadId: string): string => `thread-cake-forked-${threadId}`;

/**
 * `ProviderCommandReactor.rejectStartedThreadModelChangeIfRequired`, transcribed.
 *
 * The provider command reactor is not in this layer — nothing here starts a
 * real provider session — so its refusal has to be reproduced to be met. This
 * is a transcription of the guard's own shape rather than a call to the
 * decision under test: the point of the fork case below is that a scheduled
 * turn no longer walks into this error, and asking the decision whether the
 * decision was right would prove nothing.
 */
const rejectStartedThreadModelChange = (
  snapshot: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape,
  turn: {
    readonly threadId: string;
    readonly providerKind: string;
    readonly model: string;
  },
) =>
  Effect.gen(function* () {
    const thread = Option.getOrNull(
      yield* snapshot.getThreadDetailById(ThreadId.make(turn.threadId)),
    );
    if (thread === null || thread.session === null) return;

    const currentInstanceId = String(
      thread.session.providerInstanceId ?? thread.modelSelection.instanceId,
    );
    if (currentInstanceId === turn.providerKind && thread.modelSelection.model === turn.model) {
      return;
    }
    const requiresNewThread = (instanceId: string): boolean =>
      PROVIDERS.find((provider) => provider.instanceId === instanceId)
        ?.requiresNewThreadForModelChange === true;
    if (!requiresNewThread(currentInstanceId) && !requiresNewThread(turn.providerKind)) return;

    return yield* new CakeTurnStartError({
      cakeId: "",
      threadId: turn.threadId,
      detail: `Thread '${turn.threadId}' cannot switch models after the conversation has started. Start a new thread to use '${turn.model}'.`,
    });
  });

/**
 * The services the starter closes over.
 *
 * Captured as values rather than pulled from context inside the starter,
 * because `CakeTurnStarter` is a plain record handed to the scheduler: nothing
 * provides it a context, so an effect that still asked for one would only fail
 * at run time. `ws.ts` captures the same set for the same reason.
 */
interface CakeDispatchServices {
  readonly engine: OrchestrationEngineShape;
  readonly snapshot: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape;
  readonly repository: CakeRepositoryShape;
  readonly sql: SqlClient.SqlClient;
  /** Where this case's fork lands, if it forks. */
  readonly forkedThreadId: string;
}

const dispatchingStarter = (
  services: CakeDispatchServices & {
    readonly settleSessionStop: (threadId: string) => Effect.Effect<void>;
    readonly endSessionFirst?: boolean;
  },
): CakeTurnStarter => ({
  /**
   * The same `resolveCakeRunThread` `ws.ts` wires up, on the real engine. A
   * copy of the decision here would keep passing while the server's own version
   * drifted, and the drift that matters is silent: a cake that resolves to the
   * wrong thread still records a run and still starts a turn — just not ones
   * that can find each other.
   */
  resolveRunThread: (request) =>
    resolveCakeRunThread(request, {
      readThread: (threadId) =>
        Effect.gen(function* () {
          const thread = Option.getOrNull(
            yield* services.snapshot.getThreadDetailById(ThreadId.make(threadId)),
          );
          if (thread === null) return null;
          return {
            hasStartedConversation: thread.session !== null,
            modelSelection: {
              instanceId: String(
                thread.session?.providerInstanceId ?? thread.modelSelection.instanceId,
              ),
              model: thread.modelSelection.model,
            },
            projectId: String(thread.projectId),
            branch: thread.branch,
            worktreePath: thread.worktreePath,
          };
        }),
      dispatch: (command) => services.engine.dispatch(command),
      attachCake: ({ cakeId, threadId }) =>
        services.repository
          .attach({ cakeId, threadId, nextRunAt: null }, NOW)
          // The repository leaks `SqlClient` on purpose; the starter is a plain
          // value, so the client has to be handed to it rather than resolved.
          .pipe(Effect.provideService(SqlClient.SqlClient, services.sql)),
      newThreadId: Effect.succeed(services.forkedThreadId),
      newCommandId: (label) =>
        Effect.succeed(CommandId.make(`cmd-${label}-${services.forkedThreadId}`)),
      now: Effect.succeed(NOW),
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
    rejectStartedThreadModelChange(services.snapshot, turn).pipe(
      Effect.flatMap(() =>
        dispatchCakeTurn(
          {
            turn,
            commandId: CommandId.make(`cmd-cake-turn-${turn.threadId}`),
            sessionStopCommandId: CommandId.make(`cmd-cake-session-stop-${turn.threadId}`),
            now: NOW,
            ...(services.endSessionFirst === undefined
              ? {}
              : { endSessionFirst: services.endSessionFirst }),
          },
          {
            dispatch: (command) => services.engine.dispatch(command),
            watchSessionStopped: (threadId) => Effect.succeed(services.settleSessionStop(threadId)),
          },
        ),
      ),
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

layer("a cake turn dispatched through orchestration", (it) => {
  /**
   * `it.layer` builds one in-memory database and one engine for the whole
   * block. Cake rows are cleared per case so a run left behind cannot make a
   * later thread look owned; orchestration rows are left alone and each case
   * uses its own project, thread and command ids, because the engine dedupes on
   * command receipts and replaying an id would silently return the old result.
   */
  const seed = (ids: {
    readonly projectId: string;
    readonly threadId: string;
    /**
     * What the thread itself is on. Defaults to codex, the provider with no
     * opinion about model changes, which is what every case except the forked
     * one wants.
     */
    readonly threadModel?: { readonly instanceId: string; readonly model: string };
    /** Overrides on the cake, for the case where it cannot share its thread. */
    readonly cake?: { readonly providerKind?: string; readonly model?: string };
  }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM cake_runs`;
      yield* sql`DELETE FROM cake_thread_attachments`;
      yield* sql`DELETE FROM cakes`;

      const engine = yield* OrchestrationEngineService;
      const snapshot = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const threadModel = ids.threadModel ?? { instanceId: "codex", model: "gpt-5-codex" };
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make(`cmd-project-${ids.projectId}`),
        projectId: ProjectId.make(ids.projectId),
        title: "Cake project",
        workspaceRoot: `/tmp/${ids.projectId}`,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make(threadModel.instanceId),
          model: threadModel.model,
        },
        createdAt: NOW,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`cmd-thread-${ids.threadId}`),
        threadId: ThreadId.make(ids.threadId),
        projectId: ProjectId.make(ids.projectId),
        title: "Cake thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make(threadModel.instanceId),
          model: threadModel.model,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
      });

      const repository = yield* CakeRepository;
      yield* repository.upsert({ ...sampleCake("cake-1"), ...ids.cake }, NOW);
      yield* repository.attach({ cakeId: "cake-1", threadId: ids.threadId, nextRunAt: SLOT }, NOW);

      return { engine, repository, snapshot, sql, forkedThreadId: forkedThreadIdFor(ids.threadId) };
    });

  const tick = (
    services: CakeDispatchServices,
    options: { readonly endSessionFirst?: boolean } = {},
  ) =>
    runCakeTickOnce({
      now: Date.parse(NOW),
      shouldRunOpportunisticWork: true,
      starter: dispatchingStarter({
        ...services,
        settleSessionStop: (threadId) =>
          // Died rather than handled: the stand-in reactor failing is a broken
          // test, and the starter swallows failures, so a handled error would
          // disappear into a log line instead of failing the case.
          settleSessionStops({
            engine: services.engine,
            threadId,
            updatedAt: STOP_SETTLED_AT,
          }).pipe(Effect.orDie),
        ...options,
      }),
    });

  /** The command the provider runtime ingestion sends once a turn is live. */
  const reportSession = (input: {
    readonly engine: OrchestrationEngineShape;
    readonly commandId: string;
    readonly threadId: string;
    readonly status: "ready" | "running" | "stopped";
    readonly activeTurnId: string | null;
    readonly updatedAt: string;
    readonly providerInstanceId?: string;
  }) =>
    input.engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(input.commandId),
      threadId: ThreadId.make(input.threadId),
      session: {
        threadId: ThreadId.make(input.threadId),
        status: input.status,
        providerName: input.providerInstanceId ?? "codex",
        providerInstanceId: ProviderInstanceId.make(input.providerInstanceId ?? "codex"),
        runtimeMode: "full-access",
        activeTurnId: input.activeTurnId === null ? null : TurnId.make(input.activeTurnId),
        lastError: null,
        updatedAt: input.updatedAt,
      },
      createdAt: input.updatedAt,
    });

  /**
   * The provider command reactor, reduced to the one thing it does with a
   * `thread.session.stop`.
   *
   * The real reactor consumes `thread.session-stop-requested` off the domain
   * event stream on its own worker, so the `thread.session-set{stopped}` it
   * produces is not part of dispatching the stop — it lands whenever the
   * reactor gets to it. Calling this after a tick therefore reproduces the
   * ordering a live run produces: stop requested, then everything else the tick
   * dispatched, and only then the session actually reaching "stopped".
   *
   * Idempotent by construction rather than by bookkeeping: the command id is
   * derived from the stop's own sequence, and the engine dedupes on command
   * receipts. So a stop already settled inside the tick is not settled twice
   * here, and the same call is correct in both worlds.
   */
  const settleSessionStops = (input: {
    readonly engine: OrchestrationEngineShape;
    readonly threadId: string;
    readonly updatedAt: string;
  }) =>
    input.engine.readEvents(0, EVENT_READ_LIMIT).pipe(
      Stream.filter(
        (event) =>
          event.type === "thread.session-stop-requested" &&
          event.payload.threadId === input.threadId,
      ),
      Stream.runForEach((event) =>
        reportSession({
          engine: input.engine,
          commandId: `cmd-session-stopped-${event.sequence}`,
          threadId: input.threadId,
          status: "stopped",
          activeTurnId: null,
          updatedAt: input.updatedAt,
        }),
      ),
    );

  it.effect("is named by the thread's active-cake lookup", () =>
    Effect.gen(function* () {
      const services = yield* seed({
        projectId: "project-active",
        threadId: "thread-active",
      });

      yield* tick(services);
      yield* reportSession({
        engine: services.engine,
        commandId: "cmd-session-active-running",
        threadId: "thread-active",
        status: "running",
        activeTurnId: "turn-cake",
        updatedAt: "2026-03-10T09:00:31.000Z",
      });

      assert.equal(yield* services.repository.activeCakeIdForThread("thread-active"), "cake-1");
    }),
  );

  /**
   * The join above is an all-or-nothing answer, so on its own it says only that
   * something matched. This says what matched: the id the run wrote down is the
   * id the pipeline stored on the turn.
   *
   * Minting a fresh message id in the starter is the regression this exists
   * for. It leaves both rows present and both ids well-formed — the run has
   * one, the turn has another — so nothing errors, nothing logs, and the only
   * symptom is a Stop Cake button that never appears.
   */
  it.effect("starts the turn under the id the run recorded", () =>
    Effect.gen(function* () {
      const services = yield* seed({
        projectId: "project-ids",
        threadId: "thread-ids",
      });

      yield* tick(services);

      const runs = yield* services.repository.listRuns("cake-1");
      const recordedId = runs[0]?.turnMessageId ?? null;
      assert.isNotNull(recordedId, "the run recorded no message id");

      const sql = yield* SqlClient.SqlClient;
      const turns = yield* sql<{
        readonly pending_message_id: string | null;
      }>`SELECT pending_message_id FROM projection_turns WHERE thread_id = 'thread-ids'`;

      assert.deepEqual(
        turns.map((row) => row.pending_message_id),
        [recordedId],
      );
    }),
  );

  /**
   * Without this the positive case proves nothing: a lookup that answered
   * "cake-1" for any thread that ever ran a cake would pass it, and would offer
   * to stop a cake on a thread sitting idle.
   */
  it.effect("names nothing once the session reports no active turn", () =>
    Effect.gen(function* () {
      const services = yield* seed({
        projectId: "project-idle",
        threadId: "thread-idle",
      });

      yield* tick(services);
      yield* reportSession({
        engine: services.engine,
        commandId: "cmd-session-idle-running",
        threadId: "thread-idle",
        status: "running",
        activeTurnId: "turn-cake",
        updatedAt: "2026-03-10T09:00:31.000Z",
      });
      yield* reportSession({
        engine: services.engine,
        commandId: "cmd-session-idle-ready",
        threadId: "thread-idle",
        status: "ready",
        activeTurnId: null,
        updatedAt: "2026-03-10T09:05:00.000Z",
      });

      assert.equal(yield* services.repository.activeCakeIdForThread("thread-idle"), null);
    }),
  );

  /**
   * The case that decides whether "Stop Cake" is safe to show: the person types
   * into a thread a cake also runs on. Their turn is the active one, and
   * stopping "the cake" would stop their own work.
   */
  it.effect("names nothing while the thread runs an ordinary user turn", () =>
    Effect.gen(function* () {
      const services = yield* seed({
        projectId: "project-user",
        threadId: "thread-user",
      });

      yield* tick(services);
      yield* reportSession({
        engine: services.engine,
        commandId: "cmd-session-user-cake-running",
        threadId: "thread-user",
        status: "running",
        activeTurnId: "turn-cake",
        updatedAt: "2026-03-10T09:00:31.000Z",
      });

      yield* services.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-user-turn-start"),
        threadId: ThreadId.make("thread-user"),
        message: {
          messageId: MessageId.make("message-typed-by-a-person"),
          role: "user",
          text: "actually, do this instead",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: "2026-03-10T09:10:00.000Z",
      });
      yield* reportSession({
        engine: services.engine,
        commandId: "cmd-session-user-running",
        threadId: "thread-user",
        status: "running",
        activeTurnId: "turn-user",
        updatedAt: "2026-03-10T09:10:01.000Z",
      });

      assert.equal(yield* services.repository.activeCakeIdForThread("thread-user"), null);
    }),
  );

  /**
   * The event log in stream order, which is the only place the ordering of a
   * cake's dispatch is observable from here.
   *
   * The provider command reactor is not in this layer, so no session is really
   * started or torn down; what it consumes is this stream, in this order, one
   * event at a time. Asserting the order of the log therefore asserts the order
   * it will act in — a stop recorded after a turn start is a stop applied after
   * the turn resumed the session.
   */
  const threadEventTypes = (threadId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly event_type: string }>`
        SELECT event_type FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
        ORDER BY sequence ASC
      `;
      return rows.map((row) => row.event_type);
    });

  /**
   * "Take this thread over" — the drop dialog's stop-the-current-agent answer —
   * means ending the session before the turn starts. After the turn starts it
   * is too late: the turn has already resumed the session that was meant to be
   * discarded, and the stop then kills the run somebody just asked for.
   *
   * A *scheduled* run never asks for this; the cake switch that used to drive
   * it is gone. The sequencing is asserted here because it is still reachable,
   * and because the failure it prevents is silent.
   */
  it.effect("ends the session before the turn when the caller asks to start fresh", () =>
    Effect.gen(function* () {
      const services = yield* seed({
        projectId: "project-fresh",
        threadId: "thread-fresh",
      });

      // A session the cake must not inherit. Without one the stop would be
      // vacuous and the ordering would prove nothing.
      yield* reportSession({
        engine: services.engine,
        commandId: "cmd-session-fresh-prior",
        threadId: "thread-fresh",
        status: "ready",
        activeTurnId: null,
        updatedAt: "2026-03-10T08:59:00.000Z",
      });

      yield* tick(services, { endSessionFirst: true });

      const types = yield* threadEventTypes("thread-fresh");
      const stopIndex = types.indexOf("thread.session-stop-requested");
      const turnIndex = types.indexOf("thread.turn-start-requested");

      assert.notEqual(stopIndex, -1, "no session stop was requested");
      assert.notEqual(turnIndex, -1, "the turn never started");
      assert.isBelow(
        stopIndex,
        turnIndex,
        "the session stop landed after the turn start, so the turn resumed the session it was meant to discard",
      );
    }),
  );

  /**
   * The same fresh-session dispatch, judged by the thing it exists to keep
   * working: the thread's active-cake lookup.
   *
   * The order the events are *requested* in is not the order their effects
   * land in. `thread.session.stop` is handled asynchronously by the provider
   * command reactor, so the `thread.session-set{stopped}` it produces arrives
   * after the turn start the tick dispatched behind it — which is what
   * `settleSessionStops` reproduces here, and what a live run produces:
   *
   *   thread.session-stop-requested
   *   thread.message-sent
   *   thread.turn-start-requested      <- writes the pending turn row
   *   thread.session-set  stopped      <- deletes every pending turn row
   *   thread.session-set  running      <- names the turn id the runtime minted
   *
   * A session leaving "running" clears the thread's pending turn start, so a
   * stop that settles after the turn was requested wipes the row carrying the
   * message id the run recorded. Nothing errors and nothing logs; the only
   * symptom is that "Stop Cake" never lights for a run that started fresh,
   * which is the exact regression the join exists to prevent.
   */
  it.effect("keeps the run joined to its turn when the fresh-session stop settles late", () =>
    Effect.gen(function* () {
      const services = yield* seed({
        projectId: "project-fresh-join",
        threadId: "thread-fresh-join",
      });

      // A session the cake must not inherit. Without one the stop would be
      // vacuous and there would be nothing for the reactor to settle.
      yield* reportSession({
        engine: services.engine,
        commandId: "cmd-session-fresh-join-prior",
        threadId: "thread-fresh-join",
        status: "ready",
        activeTurnId: null,
        updatedAt: "2026-03-10T08:59:00.000Z",
      });

      yield* tick(services, { endSessionFirst: true });
      yield* settleSessionStops({
        engine: services.engine,
        threadId: "thread-fresh-join",
        updatedAt: STOP_SETTLED_AT,
      });

      // The runtime reporting the turn it minted. Always after the stop: the
      // provider cannot report a turn on a session it has not started yet.
      yield* reportSession({
        engine: services.engine,
        commandId: "cmd-session-fresh-join-running",
        threadId: "thread-fresh-join",
        status: "running",
        activeTurnId: "turn-cake",
        updatedAt: "2026-03-10T09:00:31.000Z",
      });

      assert.equal(
        yield* services.repository.activeCakeIdForThread("thread-fresh-join"),
        "cake-1",
        "the fresh-session stop settled after the turn started and unlinked the run from its turn",
      );
    }),
  );

  /**
   * What a scheduled run does, which is the case that matters now: nothing
   * extra is sent, and the thread's session survives to carry the loop's memory
   * into the next run. A stop appearing here would be a cake quietly forgetting
   * everything it had done.
   */
  it.effect("leaves the session alone on a scheduled run", () =>
    Effect.gen(function* () {
      const services = yield* seed({
        projectId: "project-resume",
        threadId: "thread-resume",
      });

      yield* reportSession({
        engine: services.engine,
        commandId: "cmd-session-resume-prior",
        threadId: "thread-resume",
        status: "ready",
        activeTurnId: null,
        updatedAt: "2026-03-10T08:59:00.000Z",
      });

      yield* tick(services);

      const types = yield* threadEventTypes("thread-resume");
      assert.notInclude(types, "thread.session-stop-requested");
      assert.include(types, "thread.turn-start-requested");
    }),
  );

  /**
   * Starting fresh on a thread that has no session at all. If the stop failed
   * there the turn would never be dispatched — the starter's error is logged
   * and swallowed, so the symptom would be a run that silently never happens.
   */
  it.effect("starts fresh without error on a thread that has no session yet", () =>
    Effect.gen(function* () {
      const services = yield* seed({
        projectId: "project-nosession",
        threadId: "thread-nosession",
      });

      yield* tick(services, { endSessionFirst: true });

      const types = yield* threadEventTypes("thread-nosession");
      assert.include(types, "thread.session-stop-requested");
      assert.include(types, "thread.turn-start-requested");

      const runs = yield* services.repository.listRuns("cake-1");
      assert.deepEqual(
        runs.map((run) => run.outcome),
        ["started"],
      );
    }),
  );
  /**
   * A run somebody asked for, taken through `runCakeNow` — the same function
   * `ws.ts` hands the `cakes.runNow` payload to.
   *
   * Driven here rather than reconstructed because the flag's whole job is to
   * travel: the RPC says "end the session first", and it has to arrive at
   * `dispatchCakeTurn` as an ordering instruction. A test that built its own
   * starter would prove the ordering works while the wire between the two was
   * cut.
   */
  const runNow = (
    services: CakeDispatchServices,
    options: { readonly threadId: string; readonly endSessionFirst: boolean },
  ) =>
    runCakeNow(
      {
        cakeId: "cake-1",
        threadId: options.threadId,
        endSessionFirst: options.endSessionFirst,
      },
      {
        now: Date.parse(NOW),
        starterFor: ({ endSessionFirst }) =>
          dispatchingStarter({
            ...services,
            settleSessionStop: (threadId) =>
              settleSessionStops({
                engine: services.engine,
                threadId,
                updatedAt: STOP_SETTLED_AT,
              }).pipe(Effect.orDie),
            endSessionFirst,
          }),
      },
    );

  /**
   * The property the old implementation was faking, and nothing was checking.
   *
   * Run now used to hand `runCakeTickOnce` a cloned `CakeRepository` whose
   * `setNextRun` did nothing. That clone was the only thing keeping a button
   * press from consuming the cake's next slot — no test asserted it, so the
   * guarantee lived entirely in a line of code that looked like plumbing. It is
   * an explicit `advanceSlots: false` now, and this is what says why it matters:
   * pressing Start to run a cake early must not quietly cancel the scheduled
   * run it was standing in for.
   */
  it.effect("leaves the schedule alone when a run is asked for by hand", () =>
    Effect.gen(function* () {
      const services = yield* seed({
        projectId: "project-runnow-slot",
        threadId: "thread-runnow-slot",
      });
      const repository = yield* CakeRepository;

      const before = yield* repository.listAttachmentsForThread("thread-runnow-slot");
      yield* runNow(services, { threadId: "thread-runnow-slot", endSessionFirst: false });
      const after = yield* repository.listAttachmentsForThread("thread-runnow-slot");

      assert.strictEqual(after[0]?.nextRunAt, before[0]?.nextRunAt);
      // And the slot it left alone is a real one, or the assertion above would
      // hold just as well for a cake that was never scheduled.
      assert.notStrictEqual(before[0]?.nextRunAt, null);
    }),
  );

  /**
   * The drop dialog's "stop the current agent, and spawn the cake" answer.
   *
   * It used to be two things travelling separately — a client-side interrupt
   * and then a run — and the second could overtake the first. Now it is one
   * call with a flag, and the flag has to come out the far end as an ordering:
   * a stop dispatched after the turn start kills the run the user just asked
   * for instead of the one they wanted gone.
   */
  it.effect("ends the session before the turn when run-now is asked to stop the agent", () =>
    Effect.gen(function* () {
      const services = yield* seed({
        projectId: "project-runnow-stop",
        threadId: "thread-runnow-stop",
      });

      // The agent the person wants stopped. Without a live session the stop
      // would be vacuous and the ordering would prove nothing.
      yield* reportSession({
        engine: services.engine,
        commandId: "cmd-session-runnow-stop-prior",
        threadId: "thread-runnow-stop",
        status: "running",
        activeTurnId: "turn-somebody-else",
        updatedAt: "2026-03-10T08:59:00.000Z",
      });

      yield* runNow(services, { threadId: "thread-runnow-stop", endSessionFirst: true });

      const types = yield* threadEventTypes("thread-runnow-stop");
      const stopIndex = types.indexOf("thread.session-stop-requested");
      const turnIndex = types.indexOf("thread.turn-start-requested");

      assert.notEqual(stopIndex, -1, "run-now sent no session stop, so the agent kept running");
      assert.notEqual(turnIndex, -1, "the cake's turn never started");
      assert.isBelow(
        stopIndex,
        turnIndex,
        "the session stop landed after the turn start, so it stopped the cake the user just spawned",
      );
    }),
  );

  /**
   * The same press, judged by the thing it exists to keep working: "Stop Cake".
   *
   * The stop settles on the provider reactor's own worker, so it lands *after*
   * the turn start it was dispatched in front of, and a session leaving
   * "running" clears the thread's pending turn row — the row carrying the
   * message id the run recorded. Waiting for the stop to reach "stopped" before
   * starting the turn is the only thing keeping the run joined to its turn.
   */
  it.effect("keeps a stop-and-spawn run joined to its turn", () =>
    Effect.gen(function* () {
      const services = yield* seed({
        projectId: "project-runnow-join",
        threadId: "thread-runnow-join",
      });

      yield* reportSession({
        engine: services.engine,
        commandId: "cmd-session-runnow-join-prior",
        threadId: "thread-runnow-join",
        status: "running",
        activeTurnId: "turn-somebody-else",
        updatedAt: "2026-03-10T08:59:00.000Z",
      });

      yield* runNow(services, { threadId: "thread-runnow-join", endSessionFirst: true });
      yield* settleSessionStops({
        engine: services.engine,
        threadId: "thread-runnow-join",
        updatedAt: STOP_SETTLED_AT,
      });
      yield* reportSession({
        engine: services.engine,
        commandId: "cmd-session-runnow-join-running",
        threadId: "thread-runnow-join",
        status: "running",
        activeTurnId: "turn-cake",
        updatedAt: "2026-03-10T09:00:31.000Z",
      });

      assert.equal(
        yield* services.repository.activeCakeIdForThread("thread-runnow-join"),
        "cake-1",
        "the stop settled after the turn started and unlinked the run from its turn",
      );
    }),
  );

  /**
   * The composer's Start button, which reaches the same method. It is an
   * ordinary run: nobody asked for the thread's session to end, and a stop here
   * would kill whatever is running in a thread the person is still using.
   */
  it.effect("sends no session stop when run-now is an ordinary start", () =>
    Effect.gen(function* () {
      const services = yield* seed({
        projectId: "project-runnow-plain",
        threadId: "thread-runnow-plain",
      });

      yield* reportSession({
        engine: services.engine,
        commandId: "cmd-session-runnow-plain-prior",
        threadId: "thread-runnow-plain",
        status: "ready",
        activeTurnId: null,
        updatedAt: "2026-03-10T08:59:00.000Z",
      });

      yield* runNow(services, { threadId: "thread-runnow-plain", endSessionFirst: false });

      const types = yield* threadEventTypes("thread-runnow-plain");
      assert.notInclude(
        types,
        "thread.session-stop-requested",
        "a plain Start tore the thread's session down",
      );
      assert.include(types, "thread.turn-start-requested");
    }),
  );

  /**
   * The bug this whole change exists for.
   *
   * A cake was attached to a thread already in a conversation on a provider
   * that refuses mid-conversation model changes. Every scheduled run came back
   * as "Thread '…' cannot switch models after the conversation has started",
   * the reactor logged it and swallowed it, and the loop simply never ran. The
   * refusal is thread-scoped, so no session-level answer could have reached it.
   *
   * `seedIncompatible` is the exact shape that failed: a started Grok thread,
   * and a cake on a different Grok model.
   */
  const seedIncompatible = (ids: { readonly projectId: string; readonly threadId: string }) =>
    Effect.gen(function* () {
      const services = yield* seed({
        projectId: ids.projectId,
        threadId: ids.threadId,
        threadModel: { instanceId: "grok", model: "grok-4" },
        cake: { providerKind: "grok", model: "grok-code" },
      });

      // The conversation, which is what fixes the thread's model. Without it
      // there is nothing to refuse and the case proves nothing.
      yield* reportSession({
        engine: services.engine,
        commandId: `cmd-session-${ids.threadId}-prior`,
        threadId: ids.threadId,
        status: "ready",
        activeTurnId: null,
        updatedAt: "2026-03-10T08:59:00.000Z",
        providerInstanceId: "grok",
      });

      return services;
    });

  const seedClaudeModelConflict = (ids: {
    readonly projectId: string;
    readonly threadId: string;
  }) =>
    Effect.gen(function* () {
      const services = yield* seed({
        projectId: ids.projectId,
        threadId: ids.threadId,
        threadModel: { instanceId: "claudeAgent", model: "claude-opus-5" },
        cake: { providerKind: "claudeAgent", model: "claude-fable-5" },
      });

      yield* reportSession({
        engine: services.engine,
        commandId: `cmd-session-${ids.threadId}-prior`,
        threadId: ids.threadId,
        status: "ready",
        activeTurnId: null,
        updatedAt: "2026-03-10T08:59:00.000Z",
        providerInstanceId: "claudeAgent",
      });

      return services;
    });

  it.effect("forks an Opus thread for a Fable cake and preserves both models", () =>
    Effect.gen(function* () {
      const services = yield* seedClaudeModelConflict({
        projectId: "project-claude-model-conflict",
        threadId: "thread-claude-opus",
      });

      yield* tick(services);

      const attached = Option.getOrNull(
        yield* services.snapshot.getThreadDetailById(ThreadId.make("thread-claude-opus")),
      );
      const forked = Option.getOrNull(
        yield* services.snapshot.getThreadDetailById(ThreadId.make(services.forkedThreadId)),
      );
      assert.equal(attached?.modelSelection.model, "claude-opus-5");
      assert.equal(String(attached?.modelSelection.instanceId), "claudeAgent");
      assert.equal(forked?.modelSelection.model, "claude-fable-5");
      assert.equal(String(forked?.modelSelection.instanceId), "claudeAgent");

      const attachedEvents = yield* threadEventTypes("thread-claude-opus");
      const forkedEvents = yield* threadEventTypes(services.forkedThreadId);
      assert.notInclude(attachedEvents, "thread.turn-start-requested");
      assert.include(forkedEvents, "thread.turn-start-requested");
    }),
  );

  it.effect("starts a turn rather than an error when the attached thread refuses the cake", () =>
    Effect.gen(function* () {
      const services = yield* seedIncompatible({
        projectId: "project-locked",
        threadId: "thread-locked",
      });

      yield* tick(services);

      const attachedEvents = yield* threadEventTypes("thread-locked");
      assert.notInclude(
        attachedEvents,
        "thread.turn-start-requested",
        "the turn was sent to the thread that refuses it, which is the error this exists to avoid",
      );

      const forkedEvents = yield* threadEventTypes(services.forkedThreadId);
      assert.include(forkedEvents, "thread.created");
      assert.include(
        forkedEvents,
        "thread.turn-start-requested",
        "the cake never ran anywhere: a scheduled loop that errors at 3am is the failure cakes exist to prevent",
      );
    }),
  );

  /**
   * The forked thread is seeded with the cake's own provider and model, which
   * is the entire reason it exists. Created on the thread's inherited selection
   * instead, it would refuse the very turn it was made for.
   */
  it.effect("seeds the forked thread with the cake's own model", () =>
    Effect.gen(function* () {
      const services = yield* seedIncompatible({
        projectId: "project-locked-model",
        threadId: "thread-locked-model",
      });

      yield* tick(services);

      const forked = Option.getOrNull(
        yield* services.snapshot.getThreadDetailById(ThreadId.make(services.forkedThreadId)),
      );
      assert.isNotNull(forked, "no thread was created for the cake");
      assert.equal(forked?.modelSelection.model, "grok-code");
      assert.equal(String(forked?.modelSelection.instanceId), "grok");
      // Named after the cake, because a scheduled run creates it while nobody
      // is watching and the title is the only thing that says which loop did.
      assert.equal(forked?.title, "Cake cake-1");
      // The same project as the thread the cake is attached to. A run in the
      // wrong checkout does its work where nobody is looking.
      assert.equal(String(forked?.projectId), "project-locked-model");
    }),
  );

  /**
   * The forked run is still the cake's run. This is the join that lights "Stop
   * Cake": the run row, the turn's message id and the session's active turn all
   * have to name the thread the work actually happened in, or the person
   * watching a cake work has no way to stop it.
   */
  it.effect("keeps a forked run joined to the cake that started it", () =>
    Effect.gen(function* () {
      const services = yield* seedIncompatible({
        projectId: "project-locked-join",
        threadId: "thread-locked-join",
      });

      yield* tick(services);
      yield* reportSession({
        engine: services.engine,
        commandId: "cmd-session-locked-join-running",
        threadId: services.forkedThreadId,
        status: "running",
        activeTurnId: "turn-cake",
        updatedAt: "2026-03-10T09:00:31.000Z",
      });

      assert.equal(
        yield* services.repository.activeCakeIdForThread(services.forkedThreadId),
        "cake-1",
        "the forked run is not joined to its turn, so Stop Cake never lights",
      );
    }),
  );

  /**
   * The schedule stays where the user put it. Attaching the fork with a slot of
   * its own would fire this cake twice per tick from then on — an invisible
   * second loop that the one UI toggle cannot stop.
   */
  it.effect("attaches the cake to its forked thread without a schedule of its own", () =>
    Effect.gen(function* () {
      const services = yield* seedIncompatible({
        projectId: "project-locked-attach",
        threadId: "thread-locked-attach",
      });

      yield* tick(services);

      const forkedAttachments = yield* services.repository.listAttachmentsForThread(
        services.forkedThreadId,
      );
      assert.deepEqual(
        forkedAttachments.map((attachment) => attachment.cakeId),
        ["cake-1"],
      );
      assert.isNull(
        forkedAttachments[0]?.nextRunAt ?? null,
        "the forked attachment carries a schedule, so the cake now fires twice per slot",
      );

      const attached = yield* services.repository.listAttachmentsForThread("thread-locked-attach");
      assert.isNotNull(
        attached[0]?.nextRunAt ?? null,
        "the attachment the user made lost its schedule",
      );
    }),
  );
});
