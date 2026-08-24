/**
 * What dropping a cake on a thread should do.
 *
 * Pure, so the interesting case can be tested without a DOM: the thread is
 * already busy, and silently interrupting it would throw away work the user can
 * watch happening. The drop asks instead, and the dialog it opens is the only
 * place the user learns a turn was already running there.
 */

export type CakeDropDecision =
  | { readonly kind: "ignore" }
  | { readonly kind: "attach"; readonly cakeId: string; readonly threadId: string }
  | { readonly kind: "ask-start"; readonly cakeId: string; readonly threadId: string }
  | {
      readonly kind: "ask";
      readonly cakeId: string;
      readonly threadId: string;
      readonly options: ReadonlyArray<"fork" | "stop-and-spawn">;
    };

export interface CakeDropInput {
  readonly cakeId: string | null;
  readonly threadId: string | null;
  readonly threadHasStarted: boolean;
  readonly threadIsBusy: boolean;
}

export function decideCakeDrop(input: CakeDropInput): CakeDropDecision {
  // The last gate before an agent starts. A drop missing either half is not a
  // drop, and guessing at one would spawn work nobody asked for.
  if (input.cakeId === null || input.threadId === null) return { kind: "ignore" };

  if (!input.threadHasStarted) {
    return { kind: "ask-start", cakeId: input.cakeId, threadId: input.threadId };
  }

  if (!input.threadIsBusy) {
    return { kind: "attach", cakeId: input.cakeId, threadId: input.threadId };
  }

  return {
    kind: "ask",
    cakeId: input.cakeId,
    threadId: input.threadId,
    // Fork first: it is the answer that loses nothing.
    options: ["fork", "stop-and-spawn"],
  };
}
