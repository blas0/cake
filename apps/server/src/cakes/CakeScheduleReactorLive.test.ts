import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BackgroundPolicySnapshot,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { BackgroundPolicy } from "../background/BackgroundPolicy.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { CakeRepository } from "./CakeRepository.ts";
import { CakeRepositoryLive } from "./CakeRepositoryLive.ts";
import { CakeScheduleReactor } from "./CakeScheduleReactor.ts";
import { CakeScheduleReactorLive, DEFAULT_TICK_INTERVAL_MS } from "./CakeScheduleReactorLive.ts";

/**
 * The layer the server composes, started the way the server starts it, with a
 * clock that can be moved.
 *
 * Every other cake test drives `runCakeTickOnce` by hand, and so did the live
 * harness — which is exactly how a release shipped in which the tick had no
 * caller at all and no test noticed. So nothing here calls the tick: the test
 * starts the reactor and moves time, and a cake either fires on its own or the
 * feature is broken.
 *
 * What this proves and what it does not: it proves that
 * `CakeScheduleReactorLive` — the same value `server.ts` puts in
 * `ReactorLayerLive` — builds a starter from ordinary services, forks a
 * repeating tick on `start()`, dispatches a real turn through the real
 * orchestration engine, and stays quiet when `BackgroundPolicy` asks it to. It
 * does not prove the server calls `start()`; `OrchestrationReactor.test.ts`
 * covers that, and the layer being absent from the server's composition is a
 * compile error rather than a silent no-op because `makeOrchestrationReactor`
 * requires the service.
 */

const TestLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
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
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-cake-reactor-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

type TurnStartRequestedEvent = Extract<
  OrchestrationEvent,
  { readonly type: "thread.turn-start-requested" }
>;

/** The tick reads one field off the snapshot; the rest is the contract's shape. */
const backgroundPolicySnapshot = (
  shouldRunOpportunisticWork: boolean,
): BackgroundPolicySnapshot => ({
  hostPower: {
    source: "unknown",
    idle: "unknown",
    idleSeconds: null,
    locked: "unknown",
    suspended: false,
    onBattery: "unknown",
    lowPowerMode: "unknown",
    thermalState: "unknown",
    stale: true,
    updatedAt: DateTime.makeUnsafe(0),
  },
  leases: [],
  activeForegroundLeaseCount: 0,
  activeScopeKeys: [],
  shouldRunOpportunisticWork,
  updatedAt: DateTime.makeUnsafe(0),
});

const backgroundPolicyLayer = (shouldRunOpportunisticWork: boolean) =>
  Layer.succeed(BackgroundPolicy, {
    reportClientActivity: () => Effect.void,
    removeRpcClient: () => Effect.void,
    reportHostPowerState: () => Effect.void,
    snapshot: Effect.succeed(backgroundPolicySnapshot(shouldRunOpportunisticWork)),
    streamChanges: Stream.empty,
    subscribe: Effect.succeed({
      latest: backgroundPolicySnapshot(shouldRunOpportunisticWork),
      changes: Stream.empty,
    }),
    hasDemand: () => Effect.succeed(false),
    shouldRunScopeWork: () => Effect.succeed(false),
    shouldRunOpportunisticWork: Effect.succeed(shouldRunOpportunisticWork),
  });

/**
 * No configured instances, which is the ordinary case: with nothing declaring
 * `requiresNewThreadForModelChange`, the run target resolves in place and the
 * cake fires on the thread it is attached to. The forked target has its own
 * coverage in `CakeScheduleReactor.dispatch.test.ts`.
 */
const providerRegistryLayer = Layer.succeed(ProviderRegistry, {
  getProviders: Effect.succeed([]),
  refresh: () => Effect.succeed([]),
  refreshInstance: () => Effect.succeed([]),
  getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
    Effect.succeed({ provider, packageName: null, update: null }),
  setProviderMaintenanceActionState: () => Effect.succeed([]),
  streamChanges: Stream.empty,
});

const layer = it.layer(TestLayer);

/** The test clock starts at the epoch, so every instant below is an offset from it. */
const SLOT_MS = 20_000;
const EPOCH_ISO = DateTime.formatIso(DateTime.makeUnsafe(0));

const sampleCake = {
  id: "cake-1",
  name: "Cake 1",
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
};

layer("CakeScheduleReactorLive", (it) => {
  /**
   * `it.layer` builds one in-memory database for the whole block, so cake rows
   * are cleared per case: an attachment left behind would make a later case
   * fire a cake it never set up, and the assertions would depend on execution
   * order rather than on behaviour. Orchestration rows are left alone and each
   * case owns its ids, because the engine dedupes on command receipts.
   */
  const seed = (ids: { readonly projectId: string; readonly threadId: string }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM cake_runs`;
      yield* sql`DELETE FROM cake_thread_attachments`;
      yield* sql`DELETE FROM cakes`;

      const engine = yield* OrchestrationEngineService;
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make(`cmd-project-${ids.projectId}`),
        projectId: ProjectId.make(ids.projectId),
        title: "Cake project",
        workspaceRoot: `/tmp/${ids.projectId}`,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt: EPOCH_ISO,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`cmd-thread-${ids.threadId}`),
        threadId: ThreadId.make(ids.threadId),
        projectId: ProjectId.make(ids.projectId),
        title: "Cake thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: EPOCH_ISO,
      });

      const repository = yield* CakeRepository;
      yield* repository.upsert(sampleCake, EPOCH_ISO);
      // A slot in the future at fork time, so the tick that runs the moment the
      // reactor starts finds nothing. Only the clock can make this cake due,
      // which is the whole claim under test.
      yield* repository.attach(
        {
          cakeId: sampleCake.id,
          threadId: ids.threadId,
          nextRunAt: DateTime.formatIso(DateTime.makeUnsafe(SLOT_MS)),
        },
        EPOCH_ISO,
      );
      return { engine, repository, sql };
    });

  const isTurnStartFor =
    (threadId: string) =>
    (event: OrchestrationEvent): event is TurnStartRequestedEvent =>
      event.type === "thread.turn-start-requested" && event.payload.threadId === threadId;

  const startedTurnsFor = (threadId: string) =>
    Effect.flatMap(OrchestrationEngineService, (engine) =>
      // Comfortably past every event these cases write, so the whole log is
      // read rather than a default page of it.
      engine.readEvents(0, 10_000).pipe(Stream.filter(isTurnStartFor(threadId)), Stream.runCollect),
    );

  it.effect("fires a due cake on its own once the tick interval elapses", () =>
    Effect.gen(function* () {
      const { repository } = yield* seed({
        projectId: "project-tick",
        threadId: "thread-tick",
      });
      const reactor = yield* CakeScheduleReactor;

      yield* reactor.start();
      // Lets the fork's first tick run at the epoch, before the slot.
      yield* TestClock.adjust(Duration.millis(1));
      assert.equal((yield* repository.listRuns(sampleCake.id)).length, 0);

      yield* TestClock.adjust(Duration.millis(DEFAULT_TICK_INTERVAL_MS));

      const runs = yield* repository.listRuns(sampleCake.id);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.outcome, "started");

      // The run and the turn have to name the same message, or "Stop Cake"
      // never lights: this is the join the whole feature hangs on, made by a
      // tick nobody asked for.
      const turns = yield* startedTurnsFor("thread-tick");
      assert.equal(turns.length, 1);
      assert.equal(turns[0]?.payload.messageId, runs[0]?.turnMessageId);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        CakeScheduleReactorLive.pipe(
          Layer.provide(Layer.mergeAll(backgroundPolicyLayer(true), providerRegistryLayer)),
        ),
      ),
    ),
  );

  /**
   * The machine can ask for quiet, and a scheduler that ignores that runs an
   * agent fleet on battery. Deferring must also leave the slot alone, so the
   * run is still owed when the machine is willing again.
   */
  it.effect("starts nothing while the host is not accepting background work", () =>
    Effect.gen(function* () {
      const { repository } = yield* seed({
        projectId: "project-quiet",
        threadId: "thread-quiet",
      });
      const reactor = yield* CakeScheduleReactor;

      yield* reactor.start();
      yield* TestClock.adjust(Duration.millis(DEFAULT_TICK_INTERVAL_MS * 3));

      assert.equal((yield* repository.listRuns(sampleCake.id)).length, 0);
      assert.equal((yield* startedTurnsFor("thread-quiet")).length, 0);
      const attachments = yield* repository.listAttachmentsForThread("thread-quiet");
      assert.equal(
        attachments[0]?.nextRunAt,
        DateTime.formatIso(DateTime.makeUnsafe(SLOT_MS)),
        "a deferred slot must stay exactly where it is",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        CakeScheduleReactorLive.pipe(
          Layer.provide(Layer.mergeAll(backgroundPolicyLayer(false), providerRegistryLayer)),
        ),
      ),
    ),
  );
});
