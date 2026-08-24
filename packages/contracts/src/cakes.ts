import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { CakeSchedule } from "./cakeSchedule.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

/**
 * A cake: an agent loop the user configures once and then leaves running.
 *
 * The shape is small on purpose. Everything here is something the scheduler
 * will act on unattended, for months, without anyone watching — so each field
 * is a decision that was made explicitly rather than a knob that accumulated.
 *
 * Two absences are as deliberate as any field.
 *
 * There is **no permission setting**. Cakes run at full permission on every
 * provider, by decision, so a thread's own runtime-mode control stays the one
 * place permissions are expressed. A second source of truth here would let the
 * two disagree, and the loser of that disagreement is always the user.
 *
 * There is **no "last run" anchor**. The next slot is computed from a fixed
 * grid (see `cakeSchedule.ts`), so a deferred or missed run cannot drag the
 * series later and later.
 *
 * There is **no session-fork switch**. It used to be here, promising "resume
 * the attached thread's session" or "start clean". The promise was not the
 * cake's to make. A started thread keeps its own provider and model, while a
 * cake configured differently runs in a fork. The server derives that target
 * at run time through `decideCakeRunTarget` rather than storing another switch.
 */

export const CakeId = TrimmedNonEmptyString.pipe(Schema.brand("CakeId"));
export type CakeId = typeof CakeId.Type;

/**
 * What a disallowed-tool list actually does on a given provider.
 *
 * The repo's rule is that every provider-shaped feature gets a per-adapter
 * decision, stated, even when that decision is "not supported here". A list the
 * form silently drops is worse than a list the form refuses: the user believes
 * a tool is off and it is not.
 */
/**
 * An effort id, or the empty string meaning "whatever this provider defaults
 * to".
 *
 * Deliberately not `TrimmedNonEmptyString` like its siblings. The empty case is
 * load-bearing: `cakeTurnCommand` branches on `effort.length > 0` and sends no
 * effort option at all when it is empty, which is how a cake defers to the
 * provider — and the only thing a model with no effort ladder can say.
 *
 * What is refused is the case between the two. `"  "` has length > 0, so it
 * would be sent as an effort option whose value is whitespace; no adapter
 * recognises that and every adapter drops it in silence, leaving the cake
 * running at an effort its own form does not show.
 */
export const CakeEffort = Schema.String.check(
  Schema.makeFilter((value) =>
    value.length === 0 || value.trim() === value
      ? undefined
      : "Effort must not be padded with whitespace.",
  ),
  Schema.makeFilter((value) =>
    value.length === 0 || value.trim().length > 0
      ? undefined
      : "Effort must name an option, or be empty for the provider's default.",
  ),
);

export const CakeConfig = Schema.Struct({
  id: CakeId,
  name: TrimmedNonEmptyString,
  providerKind: ProviderDriverKind,
  model: TrimmedNonEmptyString,
  effort: CakeEffort,
  schedule: CakeSchedule,
  disallowedTools: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([] as ReadonlyArray<string>)),
  ),
  /** CAKE.md. Sent as the user turn of every invocation, on every provider. */
  instructions: TrimmedNonEmptyString,
});
export type CakeConfig = typeof CakeConfig.Type;

/**
 * A new cake starts anchored: every day at 9 AM, in the caller's own timezone.
 *
 * Anchored rather than interval because a first cake is almost always a daily
 * routine, and because the anchored mode is the one whose default cannot be
 * dangerous — an interval default would have to pick a number, and any number
 * picked here is one somebody ships without reading.
 *
 * The timezone is a parameter and never a literal: hardcoding one is correct
 * for exactly the developer who wrote it and wrong for everyone else, and the
 * failure is silent — the cake simply runs at the wrong time.
 */
export function defaultCakeSchedule(timeZone: string): CakeSchedule {
  return { kind: "at", cadence: "day", hour: 9, meridiem: "AM", timeZone };
}

/**
 * How far a disallowed-tool list can be honoured on a given provider.
 *
 * `ProviderDriverKind` is an open branded slug — a fork can add a driver this
 * file has never heard of — so this reports the conservative answer for an
 * unknown provider rather than exhaustively switching and breaking on the
 * first one it does not recognise.
 *
 * Every provider answers the same way — the list cannot be honoured — so what
 * varies between them is only *why*, and that is what this returns. It used to
 * return a `{ kind, reason }` from a `Schema.Union` with exactly one member,
 * which was union-and-discriminant machinery guarding a distinction that did
 * not exist: no caller ever branched on `kind`, and the sole consumer read
 * `.reason`. A `native` variant was kept briefly for the day a list could reach
 * an adapter and then removed, on the reasoning that a policy the schema still
 * accepts is a policy the form can still render — which is how a promise
 * nothing keeps gets back on screen. The same reasoning removed the union.
 *
 * If a provider ever can honour a list, the return type changes then, with the
 * branch that needs it. Why none can today is recorded in the Claude case below
 * and in the plan doc.
 */
export function cakeToolEnforcementReason(providerKind: string): string {
  switch (providerKind) {
    case "claudeAgent":
      // Claude's SDK really does take a `disallowedTools` option, and that part
      // of the earlier finding still holds. What does not hold is that a cake
      // can supply it. The option is read once, when `query()` is created at
      // session start, and the live `Query` handle exposes no tool-list
      // mutator — so the list can only be applied by the session a cake shares
      // with whoever else types in that thread. Applying it there would take
      // the person's own turns down with it, and not applying it leaves the
      // list inert. Neither is worth telling the user their tool is off.
      return "Claude fixes its tool list when a session starts, and a cake shares its thread's session with you — so a cake cannot restrict its own tools without restricting yours.";
    case "cursor":
    case "grok":
      // ACP surfaces tool decisions through `session/request_permission`, and a
      // cake runs at full permission — so that request is not raised and there
      // is no moment at which a named tool can be refused. Claiming otherwise
      // would tell the user a tool is off while it runs.
      return "Cursor and Grok decide tools through a permission request, which a cake running at full permission never triggers.";
    case "codex":
      return "Codex exposes an approval policy rather than a tool list, and cakes run with approvals off, so there is no point at which a named tool can be refused.";
    default:
      return `No tool-blocking mechanism is known for the ${providerKind} provider.`;
  }
}
