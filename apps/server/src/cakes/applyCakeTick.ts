import type { CakeConfig } from "@t3tools/contracts";

import type { CakeTickDecision } from "./cakeTick.ts";

/**
 * What a tick's decisions turn into: turns to start, runs to record, slots to
 * advance.
 *
 * Pure, and separate from the reactor, so that everything worth asserting
 * happens before anything touches a database or a queue. The mistakes that
 * matter are all visible here — firing without advancing the slot, recording a
 * run that never ran, doing any work at all on a machine that asked for quiet.
 */

/**
 * The user message id a cake's turn is started with.
 *
 * Derived from the slot rather than minted, because the same value has to be
 * written twice — onto the turn that starts and onto the run that records it —
 * and a derived id keeps those two in step without threading a generator
 * through a pure planner. The slot is already the run's primary key, so this is
 * unique wherever the run is.
 */
export function cakeTurnMessageId(input: {
  readonly cakeId: string;
  readonly threadId: string;
  readonly scheduledFor: number;
}): string {
  return `cake-turn:${JSON.stringify([input.cakeId, input.threadId, input.scheduledFor])}`;
}

export interface PlannedTurn {
  readonly cakeId: string;
  readonly threadId: string;
  /** CAKE.md verbatim. The same text on every provider. */
  readonly prompt: string;
  readonly providerKind: string;
  readonly model: string;
  readonly effort: string;
  readonly disallowedTools: ReadonlyArray<string>;
}

/**
 * A turn about to be dispatched, carrying the message id it must go out with.
 *
 * Separate from `PlannedTurn` because the message id is identity rather than
 * configuration: it is what the run records, and matching it later is the only
 * way to tell that the turn a thread is running belongs to a cake.
 */
export interface PlannedTurnStart extends PlannedTurn {
  readonly messageId: string;
}

export interface PlannedRun {
  readonly cakeId: string;
  readonly threadId: string;
  readonly scheduledFor: number;
  readonly startedAt: number | null;
  readonly outcome: "started" | "missed";
  readonly detail: string | null;
  /** Null for a missed slot: nothing was started, so there is nothing to match. */
  readonly turnMessageId: string | null;
}

export interface PlannedSlotUpdate {
  readonly cakeId: string;
  readonly threadId: string;
  readonly nextRunAt: number;
}

export interface CakeTickPlan {
  readonly turns: ReadonlyArray<PlannedTurnStart>;
  readonly runs: ReadonlyArray<PlannedRun>;
  readonly slotUpdates: ReadonlyArray<PlannedSlotUpdate>;
}

/**
 * The key a resolved run thread is looked up under.
 *
 * A cake can be attached to several threads at once and each attachment
 * resolves separately, so neither half of the pair identifies a run on its own.
 */
export function cakeAttachmentKey(input: {
  readonly cakeId: string;
  readonly threadId: string;
}): string {
  return JSON.stringify([input.cakeId, input.threadId]);
}

export interface CakeTickPlanInput {
  readonly decisions: ReadonlyArray<CakeTickDecision>;
  readonly cakesById: ReadonlyMap<string, CakeConfig>;
  /**
   * Where each firing attachment's turn will really run, keyed by
   * `cakeAttachmentKey`.
   *
   * Usually the attached thread itself. It differs when the attached thread
   * cannot host the cake's provider and model — see `decideCakeRunTarget` —
   * and the caller has already created a thread that can.
   *
   * Optional, and an absent entry means "the attached thread": resolving is IO,
   * it can fail, and a tick that dropped a cake because a lookup failed would
   * be a loop that silently stopped. Falling back sends the turn where it would
   * have gone before, which either works or reports its own reason.
   */
  readonly runThreads?: ReadonlyMap<string, string>;
  readonly now: number;
}

export function planCakeTickEffects(input: CakeTickPlanInput): CakeTickPlan {
  const turns: Array<PlannedTurnStart> = [];
  const runs: Array<PlannedRun> = [];
  const slotUpdates: Array<PlannedSlotUpdate> = [];

  for (const decision of input.decisions) {
    // A defer is inert by construction. The host asked for quiet, and both a
    // recorded run and an advanced slot would be work — the second would also
    // turn the defer into a lost run.
    if (decision.kind === "defer") continue;

    // A cake can be deleted between the due query and this tick. Attachments
    // cascade so the window is narrow, but throwing here would stop every other
    // cake in the batch from firing.
    const cake = input.cakesById.get(decision.cakeId);
    if (cake === undefined) continue;

    // Advancing happens in the same plan that fires, never later: a slot left
    // in place is seen as due by the very next tick, which would start a second
    // turn on a thread already working.
    slotUpdates.push({
      cakeId: decision.cakeId,
      threadId: decision.threadId,
      nextRunAt: decision.nextRunAt,
    });

    if (decision.kind === "skip-missed") {
      runs.push({
        cakeId: decision.cakeId,
        threadId: decision.threadId,
        scheduledFor: decision.scheduledFor,
        startedAt: null,
        outcome: "missed",
        detail: "the slot passed while the scheduler was not running",
        turnMessageId: null,
      });
      continue;
    }

    // The turn and the run name the thread the work really happens in, while
    // the slot above stays on the attachment the user made. They differ only
    // when the cake had to fork, and keeping them together is what makes
    // `cakes.activeForThread` — the join that lights "Stop Cake" — resolve on
    // the thread somebody is actually looking at.
    const runThreadId =
      input.runThreads?.get(
        cakeAttachmentKey({ cakeId: decision.cakeId, threadId: decision.threadId }),
      ) ?? decision.threadId;

    const messageId = cakeTurnMessageId({
      cakeId: cake.id,
      threadId: runThreadId,
      scheduledFor: decision.scheduledFor,
    });
    turns.push({
      cakeId: cake.id,
      threadId: runThreadId,
      messageId,
      prompt: cake.instructions,
      providerKind: cake.providerKind,
      model: cake.model,
      effort: cake.effort,
      disallowedTools: cake.disallowedTools,
    });
    runs.push({
      cakeId: decision.cakeId,
      threadId: runThreadId,
      scheduledFor: decision.scheduledFor,
      startedAt: input.now,
      outcome: "started",
      detail: null,
      turnMessageId: messageId,
    });
  }

  return { turns, runs, slotUpdates };
}
