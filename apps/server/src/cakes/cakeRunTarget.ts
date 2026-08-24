/**
 * Where a cake's next turn can actually run.
 *
 * A started thread keeps the provider instance and model its user chose. A cake
 * with a different selection runs in a fork seeded with the cake's selection,
 * so neither side silently overrides the other.
 *
 * Pure and IO-free on purpose. Reading the thread and creating the forked
 * thread are the caller's business; the decision is fully testable here.
 */

export interface CakeRunThreadState {
  /**
   * Whether the thread has a provider session at all.
   *
   * This is the guard's own condition (`thread.session !== null`), not a
   * message count: a thread with a session has told a provider something, and
   * that is the point past which the model is fixed.
   */
  readonly hasStartedConversation: boolean;
  /** What the thread is on now: its selection, narrowed by its live session. */
  readonly modelSelection: {
    readonly instanceId: string;
    readonly model: string;
  };
}

export interface CakeRunModelSelection {
  readonly instanceId: string;
  readonly model: string;
}

/**
 * `in-place` runs the cake's turn on the thread it is attached to. `fork`
 * starts a new thread seeded with the cake's own provider and model and runs
 * there.
 *
 * Two variants rather than a nullable "reason": the caller has to do something
 * different in each case, and a scheduled run must never surface a reason to
 * nobody at 3am. Forking is automatic and silent by design — an unattended loop
 * that errors instead of running is the failure cakes exist to prevent.
 */
export type CakeRunTarget = { readonly kind: "in-place" } | { readonly kind: "fork" };

export interface CakeRunTargetInput {
  /**
   * Null when the thread cannot be read — deleted, or not yet projected.
   *
   * Answered `in-place` rather than `fork`: forking off a thread that is not
   * there would invent work with no home, and the dispatch that follows reports
   * the real problem instead of this function guessing at it.
   */
  readonly thread: CakeRunThreadState | null;
  readonly cake: CakeRunModelSelection;
}

export function decideCakeRunTarget(input: CakeRunTargetInput): CakeRunTarget {
  const thread = input.thread;
  if (thread === null) return { kind: "in-place" };

  // Nothing has been said to a provider yet, so nothing is fixed. This is the
  // case a brand-new thread is in, and forking one would leave the thread the
  // user just attached the cake to permanently empty.
  if (!thread.hasStartedConversation) return { kind: "in-place" };

  // Same instance and same model is not a change. The cake can use the thread
  // without overriding the thread's selection.
  if (
    thread.modelSelection.instanceId === input.cake.instanceId &&
    thread.modelSelection.model === input.cake.model
  ) {
    return { kind: "in-place" };
  }

  return { kind: "fork" };
}
