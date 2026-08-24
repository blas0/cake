import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type CommandId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideCakeRunTarget, type CakeRunThreadState } from "./cakeRunTarget.ts";

/**
 * Turning `decideCakeRunTarget`'s answer into a thread id the turn can be
 * started on.
 *
 * The decision is pure and lives next door. This is the thin effectful shell
 * around it — and it is a shared function rather than something `ws.ts` does
 * inline, for the reason `cakeTurnCommand.ts` gives about the turn itself: a
 * copy inside the WebSocket layer is unreachable from any test, so the only
 * version anyone could assert on would be a reconstruction, and a
 * reconstruction keeps passing while the real one drifts.
 *
 * Forking is silent by design. A cake fires unattended; asking a question or
 * raising an error at 3am is the failure mode the whole feature exists to
 * prevent.
 */

export type CakeForkThreadCommand = Extract<OrchestrationCommand, { type: "thread.create" }>;

/** What a cake needs to know about itself to find a home for its next turn. */
export interface CakeRunRequest {
  readonly cakeId: string;
  /** Used as the forked thread's title, so the thread is identifiably the cake's. */
  readonly cakeName: string;
  /** The thread the cake is attached to — where it runs unless it cannot. */
  readonly threadId: string;
  readonly instanceId: string;
  readonly model: string;
}

/**
 * The attached thread, as much of it as forking needs.
 *
 * The project, branch and worktree are carried across rather than defaulted: a
 * cake that ran in the wrong checkout would be worse than one that did not run,
 * because its work would land somewhere nobody is looking.
 */
export interface CakeRunSourceThread extends CakeRunThreadState {
  readonly projectId: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

export interface CakeRunThreadIO<E, R = never> {
  /** Null when the thread cannot be read; the decision treats that as in-place. */
  readonly readThread: (threadId: string) => Effect.Effect<CakeRunSourceThread | null, E, R>;
  readonly dispatch: (command: OrchestrationCommand) => Effect.Effect<unknown, E, R>;
  /**
   * Records the cake against the thread it really ran in.
   *
   * Attached with no next run of its own: the schedule stays on the attachment
   * the user made, and a second scheduled attachment would fire the cake twice
   * per slot — an invisible loop the single UI toggle cannot stop.
   */
  readonly attachCake: (input: {
    readonly cakeId: string;
    readonly threadId: string;
  }) => Effect.Effect<void, E, R>;
  readonly newThreadId: Effect.Effect<string, E, R>;
  readonly newCommandId: (label: string) => Effect.Effect<CommandId, E, R>;
  readonly now: Effect.Effect<string, E, R>;
}

export function buildCakeForkThreadCommand(input: {
  readonly request: CakeRunRequest;
  readonly source: CakeRunSourceThread;
  readonly threadId: string;
  readonly commandId: CommandId;
  readonly now: string;
}): CakeForkThreadCommand {
  return {
    type: "thread.create" as const,
    commandId: input.commandId,
    threadId: ThreadId.make(input.threadId),
    projectId: ProjectId.make(input.source.projectId),
    // The cake's own name, so the thread a scheduled run appears in says which
    // loop made it. Nobody is watching when it is created.
    title: input.request.cakeName,
    // Seeded with the cake's provider and model, which is the whole point: this
    // thread exists precisely because the attached one could not host them.
    modelSelection: {
      instanceId: ProviderInstanceId.make(input.request.instanceId),
      model: input.request.model,
    },
    // The same unattended mode the cake's turn carries. A thread created in a
    // different mode makes the turn's own `runtimeMode` a change, which
    // restarts the session it just started.
    runtimeMode: "full-access" as const,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: input.source.branch,
    worktreePath: input.source.worktreePath,
    createdAt: input.now,
  };
}

/**
 * The thread this cake's next turn must be started on.
 *
 * Returns the attached thread untouched whenever it can host the cake, and
 * otherwise creates a thread seeded with the cake's own provider and model and
 * returns that. The cake is attached to the new thread before the id is
 * returned, so the run recorded against it, the turn started in it, and the
 * `cakes.activeForThread` join that lights "Stop Cake" all name the same thread.
 */
export const resolveCakeRunThread = <E, R>(
  request: CakeRunRequest,
  io: CakeRunThreadIO<E, R>,
): Effect.Effect<string, E, R> =>
  Effect.gen(function* () {
    const source = yield* io.readThread(request.threadId);
    const target = decideCakeRunTarget({
      thread: source,
      cake: { instanceId: request.instanceId, model: request.model },
    });

    if (target.kind === "in-place" || source === null) return request.threadId;

    const threadId = yield* io.newThreadId;
    const commandId = yield* io.newCommandId("cake-fork-thread");
    const now = yield* io.now;
    yield* io.dispatch(buildCakeForkThreadCommand({ request, source, threadId, commandId, now }));
    yield* io.attachCake({ cakeId: request.cakeId, threadId });
    return threadId;
  });
