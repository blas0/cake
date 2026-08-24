// @effect-diagnostics nodeBuiltinImport:off
/**
 * cake-live-loop — a scheduled cake turn taken all the way to a real agent.
 *
 * Everything below the projection layer already has tests. What none of them
 * touch is the last hop: a due cake, dispatched through the real orchestration
 * engine, picked up by the real `ProviderCommandReactor`, spawning a real
 * provider CLI, and coming back with text. That hop needs network,
 * credentials and subprocesses, so it can never be a unit test — this is a
 * script, run by hand, and nothing in CI invokes it.
 *
 * Three things it exists to observe, none of which a projection-level test can
 * see:
 *
 *   - the derived message id surviving into a real turn. `cakes.activeForThread`
 *     joins `cake_runs.turn_message_id` to `projection_turns.pending_message_id`,
 *     and any hop that mints an id of its own leaves both rows well-formed and
 *     the join empty.
 *   - a scheduled run keeping the thread's session rather than discarding it.
 *     The cake's session-fork switch is gone; a run never sends a
 *     `thread.session.stop` of its own.
 *   - `runtimeMode: "full-access"` mapping to each provider's unattended mode.
 *     If a provider stops to ask for approval here, a cake scheduled for 3am
 *     hangs until someone wakes up.
 *
 * Usage:
 *   node apps/server/scripts/cake-live-loop.ts <providerKind> [--repo <dir>] [--home <dir>]
 *
 * The prompt is deliberately inert. A cake runs at full access, so the prompt
 * is the only thing keeping this boring.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Cause from "effect/Cause";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { FetchHttpClient } from "effect/unstable/http";

import * as ServerConfig from "../src/config.ts";
import { ObservabilityLive } from "../src/observability/Layers/Observability.ts";
import * as ResourceAttribution from "../src/resourceTelemetry/ResourceAttribution.ts";
import * as VcsProcess from "../src/vcs/VcsProcess.ts";
import { CakeRepository } from "../src/cakes/CakeRepository.ts";
import { CakeRepositoryLive } from "../src/cakes/CakeRepositoryLive.ts";
import { watchThreadSessionStopped } from "../src/cakes/cakeSessionStopWatch.ts";
import { dispatchCakeTurn } from "../src/cakes/cakeTurnCommand.ts";
import {
  CakeTurnStartError,
  runCakeTickOnce,
  type CakeTurnStarter,
} from "../src/cakes/CakeScheduleReactor.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationReactor } from "../src/orchestration/Services/OrchestrationReactor.ts";
import { RuntimeDependenciesLive } from "../src/server.ts";

/** CAKE.md for this run. Says nothing, asks for nothing, touches nothing. */
const INERT_INSTRUCTIONS =
  "Reply with the single word: ok. Do not run any commands, do not read or write any files.";

const DEFAULT_REPO = "/tmp/cake-live-loop";
const DEFAULT_HOME_ROOT = "/tmp/cake-live-loop-home";
const TURN_TIMEOUT_MS = 240_000;
const POLL_INTERVAL_MS = 1_000;

interface Args {
  readonly providerKind: string;
  readonly repo: string;
  readonly homeRoot: string;
}

function parseArgs(argv: ReadonlyArray<string>): Args {
  const positional: Array<string> = [];
  let repo = DEFAULT_REPO;
  let homeRoot = DEFAULT_HOME_ROOT;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--repo") {
      repo = argv[index + 1] ?? repo;
      index += 1;
    } else if (token === "--home") {
      homeRoot = argv[index + 1] ?? homeRoot;
      index += 1;
    } else if (token !== undefined) {
      positional.push(token);
    }
  }
  const providerKind = positional[0];
  if (providerKind === undefined) {
    throw new Error(
      "usage: node apps/server/scripts/cake-live-loop.ts <providerKind> [--repo <dir>] [--home <dir>]",
    );
  }
  return { providerKind, repo, homeRoot };
}

/**
 * The developer's real T3 Code home, and the checkout a review instance may be
 * running against, are both live databases. Booting a second server on either
 * would corrupt state a person is using, so refusing is the only safe answer —
 * and refusing loudly beats a run that quietly succeeds against the wrong home.
 */
function assertDisposableHome(homeDir: string): void {
  const resolved = NodePath.resolve(homeDir);
  const forbidden = [
    NodePath.join(NodeProcess.env.HOME ?? "", ".t3"),
    NodePath.resolve(NodePath.join(import.meta.dirname, "../../..", ".t3")),
  ];
  for (const candidate of forbidden) {
    if (candidate.length > 0 && (resolved === candidate || resolved.startsWith(`${candidate}/`))) {
      throw new Error(`refusing to run against a live T3 Code home: ${resolved}`);
    }
  }
}

function log(line: string): void {
  NodeProcess.stdout.write(`${line}\n`);
}

interface StageReport {
  readonly tickFired: boolean;
  readonly sessionStarted: boolean;
  readonly outputProduced: boolean;
  readonly terminalOutcome: string | null;
  readonly providerSessionId: string | null;
  readonly assistantText: string | null;
  readonly runMessageId: string | null;
  readonly turnPendingMessageId: string | null;
  readonly turnState: string | null;
  readonly sessionStopBeforeTurn: boolean | null;
  readonly lastError: string | null;
  readonly approvalsRequested: number;
}

const isoAt = (millis: number): string => DateTime.formatIso(DateTime.makeUnsafe(millis));

const args = parseArgs(NodeProcess.argv.slice(2));
assertDisposableHome(args.homeRoot);

// A home per provider: this reads the thread's event stream, and a home
// carried over from another provider's run would seed it.
const baseDir = NodePath.join(NodePath.resolve(args.homeRoot), args.providerKind);
NodeFS.rmSync(baseDir, { recursive: true, force: true });
NodeFS.mkdirSync(baseDir, { recursive: true });

if (!NodeFS.existsSync(args.repo)) {
  throw new Error(`scratch repo does not exist: ${args.repo}`);
}

const providerKind = ProviderDriverKind.make(args.providerKind);
const model = DEFAULT_MODEL_BY_PROVIDER[providerKind];
if (model === undefined) {
  throw new Error(`no default model is known for provider kind '${args.providerKind}'`);
}
const instanceId = ProviderInstanceId.make(args.providerKind);

// The same composition `makeServerLayer` wraps its routes around, minus the
// routes: reactors, providers and orchestration, standing on the platform
// services the server gives them.
const AppLayer = CakeRepositoryLive.pipe(
  Layer.provideMerge(RuntimeDependenciesLive),
  Layer.provideMerge(NetService.layer),
  Layer.provide(ObservabilityLive.pipe(Layer.provideMerge(ResourceAttribution.layer))),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(ServerConfig.layerTest(args.repo, baseDir)),
  Layer.provideMerge(NodeServices.layer),
);

const program = Effect.gen(function* () {
  const reactor = yield* OrchestrationReactor;
  const engine = yield* OrchestrationEngineService;
  const repository = yield* CakeRepository;
  const sql = yield* SqlClient.SqlClient;

  // Same call `serverRuntimeStartup` makes. Without it the domain event stream
  // has no subscriber and the turn is recorded but never dispatched.
  yield* reactor.start();

  const projectId = ProjectId.make(`project-cake-live-${args.providerKind}`);
  const threadId = ThreadId.make(`thread-cake-live-${args.providerKind}`);
  const cakeId = `cake-live-${args.providerKind}`;

  const startedAt = yield* Clock.currentTimeMillis;
  const nowIso = isoAt(startedAt);

  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make(`cmd-project-${projectId}`),
    projectId,
    title: "Cake live loop",
    workspaceRoot: args.repo,
    defaultModelSelection: { instanceId, model },
    createdAt: nowIso,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`cmd-thread-${threadId}`),
    threadId,
    projectId,
    title: "Cake live loop",
    modelSelection: { instanceId, model },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt: nowIso,
  });

  // Well inside `decideCakeTick`'s lateness grace, so the slot fires rather
  // than being written off as missed.
  const slot = startedAt - 30_000;
  yield* repository.upsert(
    {
      id: cakeId,
      name: "Cake live loop",
      providerKind: args.providerKind,
      model,
      // Empty means "the provider's own default": an effort ladder differs per
      // provider and a wrong rung is a turn that fails for the wrong reason.
      effort: "",
      schedule: { kind: "at", cadence: "day", hour: 9, meridiem: "AM", timeZone: "UTC" },
      disallowedTools: [],
      instructions: INERT_INSTRUCTIONS,
    },
    nowIso,
  );
  yield* repository.attach({ cakeId, threadId, nextRunAt: isoAt(slot) }, nowIso);

  /** The starter `ws.ts` wires into the reactor, minus the WebSocket world. */
  const starter: CakeTurnStarter = {
    // This script drives one thread it created itself with the cake's own
    // provider and model, so there is nothing to resolve away from. The forked
    // path is covered by `CakeScheduleReactor.dispatch.test.ts`.
    resolveRunThread: (request) => Effect.succeed(request.threadId),
    startTurn: (turn) =>
      Effect.gen(function* () {
        const createdAt = isoAt(yield* Clock.currentTimeMillis);
        // A scheduled run asks for no session stop. The sequencing inside
        // `dispatchCakeTurn` still matters for the caller that does ask: a stop
        // is handled asynchronously, so one dispatched ahead of the turn but
        // landing after it clears the pending turn row
        // `activeCakeIdForThread` joins through.
        yield* dispatchCakeTurn(
          {
            turn,
            commandId: CommandId.make(`cmd-cake-turn-${turn.threadId}`),
            sessionStopCommandId: CommandId.make(`cmd-cake-session-stop-${turn.threadId}`),
            now: createdAt,
          },
          {
            dispatch: (command) => engine.dispatch(command),
            watchSessionStopped: (threadId) => watchThreadSessionStopped(engine, threadId),
          },
        );
      }).pipe(
        Effect.scoped,
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
  };

  yield* runCakeTickOnce({
    now: startedAt,
    shouldRunOpportunisticWork: true,
    starter,
  });

  const readState = Effect.gen(function* () {
    const runs = yield* repository.listRuns(cakeId);
    const run = runs[0];
    const runtimeSessions = yield* sql<{
      readonly status: string;
      readonly runtime_mode: string;
      readonly resume_cursor_json: string | null;
    }>`SELECT status, runtime_mode, resume_cursor_json FROM provider_session_runtime WHERE thread_id = ${threadId}`;
    const activeCakeId = yield* repository.activeCakeIdForThread(threadId);
    const turns = yield* sql<{
      readonly turn_id: string | null;
      readonly pending_message_id: string | null;
      readonly state: string;
      readonly completed_at: string | null;
    }>`SELECT turn_id, pending_message_id, state, completed_at FROM projection_turns WHERE thread_id = ${threadId} ORDER BY row_id ASC`;
    const sessions = yield* sql<{
      readonly status: string;
      readonly provider_session_id: string | null;
      readonly last_error: string | null;
    }>`SELECT status, provider_session_id, last_error FROM projection_thread_sessions WHERE thread_id = ${threadId}`;
    const assistant = yield* sql<{
      readonly text: string;
      readonly is_streaming: number;
    }>`SELECT text, is_streaming FROM projection_thread_messages WHERE thread_id = ${threadId} AND role = 'assistant' ORDER BY created_at ASC`;
    const approvals = yield* sql<{
      readonly count: number;
    }>`SELECT COUNT(*) AS count FROM projection_pending_approvals WHERE thread_id = ${threadId}`;
    const events = yield* sql<{ readonly event_type: string }>`
      SELECT event_type FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
      ORDER BY sequence ASC
    `;
    const types = events.map((row) => row.event_type);
    const stopIndex = types.indexOf("thread.session-stop-requested");
    const turnIndex = types.indexOf("thread.turn-start-requested");
    const settledText = assistant
      .filter((row) => row.is_streaming === 0)
      .map((row) => row.text)
      .join("\n")
      .trim();

    // The turn that carries a provider turn id is the one the run caused; the
    // pending row the dispatch writes has none yet.
    const identifiedTurn = turns.find((turn) => turn.turn_id !== null) ?? turns[0];

    return {
      tickFired: run !== undefined,
      runMessageId: run?.turnMessageId ?? null,
      turnPendingMessageId: identifiedTurn?.pending_message_id ?? null,
      turnState: identifiedTurn?.state ?? null,
      turnCompletedAt: identifiedTurn?.completed_at ?? null,
      // A provider session, not a projection row: this is the runtime record
      // the adapter writes when a real process is behind it.
      sessionStarted: runtimeSessions.length > 0,
      runtimeMode: runtimeSessions[0]?.runtime_mode ?? null,
      providerSessionId: runtimeSessions[0]?.resume_cursor_json ?? null,
      lastError: sessions[0]?.last_error ?? null,
      assistantText: settledText.length > 0 ? settledText : null,
      approvalsRequested: approvals[0]?.count ?? 0,
      activeCakeId,
      sessionStopBeforeTurn:
        stopIndex === -1 || turnIndex === -1 ? null : ((stopIndex < turnIndex) as boolean),
    } as const;
  });

  // Poll rather than subscribe: the projection is the thing the UI reads, and
  // a turn that only ever settled on an in-memory stream would still be a bug.
  const deadline = startedAt + TURN_TIMEOUT_MS;
  let state = yield* readState;
  // Sticky, because both are mid-turn states. A session that has already
  // stopped and a "Stop Cake" that has already stopped offering are both
  // invisible to a single reading taken after the turn settles.
  let sessionEverStarted = state.sessionStarted;
  let activeCakeEverNamed = state.activeCakeId;
  while (
    state.turnCompletedAt === null &&
    state.lastError === null &&
    (yield* Clock.currentTimeMillis) < deadline
  ) {
    yield* Effect.sleep(Duration.millis(POLL_INTERVAL_MS));
    state = yield* readState;
    sessionEverStarted = sessionEverStarted || state.sessionStarted;
    activeCakeEverNamed = activeCakeEverNamed ?? state.activeCakeId;
  }

  const terminalOutcome =
    state.lastError !== null
      ? `session error: ${state.lastError}`
      : state.turnCompletedAt !== null
        ? `turn ${state.turnState} at ${state.turnCompletedAt}`
        : state.assistantText !== null
          ? `assistant replied, turn state ${state.turnState ?? "unknown"}`
          : null;

  const report: StageReport = {
    tickFired: state.tickFired,
    sessionStarted: sessionEverStarted,
    outputProduced: state.assistantText !== null,
    terminalOutcome,
    providerSessionId: state.providerSessionId,
    assistantText: state.assistantText,
    runMessageId: state.runMessageId,
    turnPendingMessageId: state.turnPendingMessageId,
    turnState: state.turnState,
    sessionStopBeforeTurn: state.sessionStopBeforeTurn,
    lastError: state.lastError,
    approvalsRequested: state.approvalsRequested,
  };

  const cakeRunRows = yield* sql<{
    readonly id: string;
    readonly outcome: string;
    readonly turn_message_id: string | null;
    readonly started_at: string | null;
  }>`SELECT id, outcome, turn_message_id, started_at FROM cake_runs`;

  return {
    report,
    cakeRunRows,
    activeCakeId: activeCakeEverNamed,
    runtimeMode: state.runtimeMode,
  } as const;
});

const main = Effect.gen(function* () {
  const outcome = yield* program;
  const { report } = outcome;

  log("");
  log(`=== cake-live-loop: ${args.providerKind} ===`);
  log(`home              ${baseDir}`);
  log(`repo              ${args.repo}`);
  log(`model             ${model}`);
  log("");
  log("-- the loop --");
  log(`tick fired        ${report.tickFired ? "yes" : "NO"}`);
  log(`session started   ${report.sessionStarted ? "yes" : "NO"}`);
  log(`provider session  ${report.providerSessionId ?? "(none)"}`);
  log(`output produced   ${report.outputProduced ? "yes" : "NO"}`);
  log(`terminal outcome  ${report.terminalOutcome ?? "(none — timed out)"}`);
  log(`turn state        ${report.turnState ?? "(none)"}`);
  log(`session last err  ${report.lastError ?? "(none)"}`);
  log("");
  log("-- what a projection-level test cannot see --");
  log(`runtime mode      ${outcome.runtimeMode ?? "(none)"}`);
  log(`approvals asked   ${report.approvalsRequested}`);
  log(
    `stop before turn  ${
      report.sessionStopBeforeTurn === null
        ? "(not observable — one of the two events is missing)"
        : report.sessionStopBeforeTurn
          ? "yes"
          : "NO"
    }`,
  );
  log(`run message id    ${report.runMessageId ?? "(none)"}`);
  log(`turn pending id   ${report.turnPendingMessageId ?? "(none)"}`);
  log(`ids match         ${report.runMessageId === report.turnPendingMessageId ? "yes" : "NO"}`);
  log(`activeForThread   ${outcome.activeCakeId ?? "(null)"}`);
  log("");
  log("cake_runs:");
  for (const row of outcome.cakeRunRows) {
    log(
      `  id=${row.id} outcome=${row.outcome} started_at=${row.started_at ?? "null"} turn_message_id=${row.turn_message_id ?? "null"}`,
    );
  }
  log("");
  log("assistant text:");
  log(
    report.assistantText === null ? "  (none)" : `  ${report.assistantText.replace(/\n/g, "\n  ")}`,
  );
  log("");

  // The loop itself: did a scheduled cake reach a real agent and come back.
  const loopFailures: Array<string> = [];
  if (!report.tickFired) loopFailures.push("the tick recorded no run");
  if (!report.sessionStarted) loopFailures.push("no provider session was started");
  if (!report.outputProduced) loopFailures.push("the agent produced no assistant output");
  if (report.terminalOutcome === null) loopFailures.push("the run reached no terminal outcome");
  if (report.lastError !== null) {
    loopFailures.push(`session reported an error: ${report.lastError}`);
  }

  // Reported apart from the loop because these fail without the loop failing:
  // the turn still runs and still answers, and the only symptom is a control
  // that never appears or an approval nobody is awake to give.
  const behaviourFailures: Array<string> = [];
  if (report.runMessageId !== report.turnPendingMessageId) {
    behaviourFailures.push(
      "the run's message id is not the identified turn's pending message id, so cakes.activeForThread cannot match and Stop Cake never appears",
    );
  }
  if (outcome.activeCakeId === null) {
    behaviourFailures.push("cakes.activeForThread never named this cake while the turn ran");
  }
  // A scheduled run keeps the thread's session. The stop that used to precede a
  // fresh-session cake is gone with the switch that drove it, so seeing one here
  // means something re-attached it and the loop is losing its own memory.
  if (report.sessionStopBeforeTurn !== null) {
    behaviourFailures.push(
      "a scheduled run stopped the session, discarding the memory the loop was meant to keep",
    );
  }
  if (report.approvalsRequested > 0) {
    behaviourFailures.push("full-access still raised an approval request");
  }

  if (loopFailures.length > 0 || behaviourFailures.length > 0) {
    log(`RESULT ${args.providerKind}: FAIL`);
    for (const failure of loopFailures) {
      log(`  [loop] ${failure}`);
    }
    for (const failure of behaviourFailures) {
      log(`  [behaviour] ${failure}`);
    }
    return 1;
  }
  log(`RESULT ${args.providerKind}: PASS`);
  return 0;
});

const exit = await Effect.runPromiseExit(
  main.pipe(Effect.provide(AppLayer), Effect.scoped, Effect.timeout(Duration.millis(600_000))),
);

if (Exit.isSuccess(exit)) {
  process.exitCode = exit.value;
} else {
  NodeProcess.stderr.write(`${Cause.pretty(exit.cause)}\n`);
  log(`RESULT ${args.providerKind}: FAIL (the harness itself failed)`);
  process.exitCode = 1;
}
// Provider adapters keep child processes and watchers alive; the runtime scope
// has closed, but node would otherwise linger on stray handles.
process.exit(process.exitCode ?? 0);
