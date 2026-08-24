import {
  MessageId,
  type CommandId,
  type OrchestrationCommand,
  ProviderDriverKind,
  ProviderInstanceId,
  defaultInstanceIdForDriver,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { PlannedTurnStart } from "./applyCakeTick.ts";

/**
 * Where a cake stops being cake-shaped and becomes an ordinary turn.
 *
 * Everything upstream of this knows about schedules and loops; everything
 * downstream is the turn machinery t3code already has. That makes this the seam
 * where a cake's configuration either reaches the provider or is quietly
 * dropped — and dropped is the likely failure, because a turn missing a field
 * still runs, just not as the user configured it.
 *
 * It is a plain function rather than part of the WebSocket layer so the command
 * the server really sends is the command a test can hold. While this lived
 * inline in `ws.ts` the only reachable version of it was the one no test could
 * import, and the copies that were tested were reconstructions.
 */

export type CakeTurnCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

export type CakeSessionStopCommand = Extract<OrchestrationCommand, { type: "thread.session.stop" }>;

export interface CakeTurnCommandInput {
  /**
   * Carries its own message id. The id is not a parameter here because it must
   * not be a choice: the run recorded that exact value, and minting a fresh one
   * would leave the turn untraceable to the cake that started it.
   */
  readonly turn: PlannedTurnStart;
  /** Minted by the caller; command ids are never invented down here. */
  readonly commandId: CommandId;
  readonly now: string;
  /**
   * The provider instance to route to.
   *
   * Absent for a scheduled cake, which is configured by driver kind rather than
   * by instance — and then the driver's canonical default instance is used.
   */
  readonly instanceId?: ProviderInstanceId | undefined;
}

export function buildCakeTurnCommand(input: CakeTurnCommandInput): CakeTurnCommand {
  const { turn } = input;

  return {
    type: "thread.turn.start" as const,
    commandId: input.commandId,
    threadId: ThreadId.make(turn.threadId),
    message: {
      // The planner's id, not a fresh one: the same value was recorded against
      // the run, and it is what later ties the thread's active turn back to the
      // cake that started it.
      messageId: MessageId.make(turn.messageId),
      role: "user" as const,
      // CAKE.md verbatim. The same text on every provider, and visible in the
      // transcript rather than hidden in a system prompt nobody can read back.
      text: turn.prompt,
      attachments: [],
    },
    modelSelection: {
      // `defaultInstanceIdForDriver`, not a hand-rolled `make`. The mapping
      // from a driver kind to its default instance id is a real, documented
      // back-compat rule that this repo owns in one place; spelling it inline
      // reads as a cast that launders a driver kind into an instance id, and
      // would drift the day that rule changes.
      instanceId:
        input.instanceId ?? defaultInstanceIdForDriver(ProviderDriverKind.make(turn.providerKind)),
      model: turn.model,
      // An empty effort is "the provider's own default", which is said by
      // sending no option at all — an option with an empty value is a value.
      ...(turn.effort.length > 0
        ? {
            options: [
              {
                // Codex names the same knob differently, and an option the
                // adapter does not recognise is dropped in silence.
                id: turn.providerKind === "codex" ? "reasoningEffort" : "effort",
                value: turn.effort,
              },
            ],
          }
        : {}),
    },
    /**
     * The decision that makes cakes work at all. Every adapter maps this to its
     * own unattended mode — Claude's `bypassPermissions`, Codex's `never` plus
     * `danger-full-access`. Any other value means a scheduled cake stops at 3am
     * waiting for an approval nobody is awake to give.
     */
    runtimeMode: "full-access" as const,
    /**
     * Never `plan`. A cake is not a person typing, so it must not land in a mode
     * that produces a proposal and waits for someone to accept it.
     */
    interactionMode: "default" as const,
    createdAt: input.now,
  };
}

export interface CakeTurnDispatchInput extends CakeTurnCommandInput {
  /**
   * Minted by the caller alongside the turn's own id. Always required, even
   * when no stop is sent: an id that only sometimes exists is an id the caller
   * can forget to mint on the one path that needs it.
   */
  readonly sessionStopCommandId: CommandId;
  /**
   * End the thread's provider session before the turn starts.
   *
   * An explicit instruction from the caller rather than something read off the
   * cake. It used to be the cake's own `sessionFork` switch, which promised a
   * fresh session would let a cake run its own model on somebody else's thread
   * — a promise a session-level stop cannot keep, because the model-change
   * refusal it was meant to sidestep is scoped to the thread. Where a scheduled
   * run happens is derived now (`cakeRunTarget.ts`), and the scheduler asks for
   * no stop at all: both of its answers land on a session it may keep.
   *
   * The stop itself stays, and stays sequenced correctly, because ending the
   * agent currently working in a thread and starting a cake there in its place
   * is a thing a person can still ask for from the drop dialog.
   *
   * Defaults to false, which is an ordinary turn start.
   */
  readonly endSessionFirst?: boolean;
}

/**
 * The stop that has to happen before the turn, or `null` when the turn simply
 * continues whatever session the thread already has.
 *
 * Continuing is the de-facto behaviour of an ordinary turn start, so it is said
 * by sending nothing extra; starting fresh is that same turn start with a
 * session stop in front of it.
 */
export function buildCakeSessionStopCommand(
  input: CakeTurnDispatchInput,
): CakeSessionStopCommand | null {
  if (input.endSessionFirst !== true) {
    return null;
  }

  return {
    type: "thread.session.stop" as const,
    commandId: input.sessionStopCommandId,
    threadId: ThreadId.make(input.turn.threadId),
    createdAt: input.now,
    /**
     * Deliberately unconditional — `onlyIfSettled` is the settle-cleanup
     * guard, and it drops the stop whenever a session is alive or a turn is
     * queued. That is exactly the state a cake is in when it fires, so the
     * guard would discard the stop precisely when it matters.
     */
  };
}

/**
 * Everything a scheduled turn needs from the world outside this function.
 *
 * Taken as an argument rather than as services so the ordering below is the
 * ordering the server really runs and a test can hold: the server and the
 * dispatch test drive this same function, so an inversion here fails a test
 * instead of only production.
 */
export interface CakeTurnDispatchIO<E, R = never> {
  readonly dispatch: (command: OrchestrationCommand) => Effect.Effect<unknown, E, R>;
  /**
   * Begins watching for the thread's session to reach `stopped`, and returns
   * the wait.
   *
   * Two steps rather than one because the signal is live: the session reaching
   * `stopped` is an event, and a watch attached after the stop was dispatched
   * can miss it entirely. Calling this before dispatching the stop is what
   * makes the wait below safe.
   */
  readonly watchSessionStopped: (
    threadId: string,
  ) => Effect.Effect<Effect.Effect<void, E, R>, E, R>;
}

/**
 * A cake's turn, sent in the order its steps must actually take effect.
 *
 * The order is the whole of `endSessionFirst`. Dispatching `thread.turn.start`
 * on its own continues whatever session the thread already has, so "start
 * fresh" is expressed by ending that session first — and only first.
 *
 * "First" has to mean the stop has *landed*, not that its command was sent
 * first. `thread.session.stop` is handled asynchronously by the provider
 * command reactor, so dispatching the two back to back puts the turn's
 * `thread.turn-start-requested` ahead of the `thread.session-set{stopped}` the
 * stop produces. Two things break when it does: the turn is free to resume the
 * very session the cake meant to discard, and the stopped session clears the
 * thread's pending turn start — the row holding the message id
 * `cakes.activeForThread` joins on — leaving the run permanently unlinked from
 * the turn it started, so "Stop Cake" never lights.
 */
export const dispatchCakeTurn = <E, R>(
  input: CakeTurnDispatchInput,
  io: CakeTurnDispatchIO<E, R>,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    const turnCommand = buildCakeTurnCommand(input);
    const stopCommand = buildCakeSessionStopCommand(input);

    if (stopCommand === null) {
      yield* io.dispatch(turnCommand);
      return;
    }

    const sessionStopped = yield* io.watchSessionStopped(input.turn.threadId);
    yield* io.dispatch(stopCommand);
    yield* sessionStopped;
    yield* io.dispatch(turnCommand);
  });
