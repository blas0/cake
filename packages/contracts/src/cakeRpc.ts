import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  CakeAnchorCadence,
  CakeClockHour,
  CakeIntervalCount,
  CakeIntervalUnit,
  CakeMeridiem,
  CakeTimeZone,
  CAKE_MINIMUM_INTERVAL_MESSAGE,
  isCakeIntervalTooShort,
} from "./cakeSchedule.ts";
import { ThreadId } from "./baseSchemas.ts";
import { CakeConfig, CakeId } from "./cakes.ts";

/**
 * What a client may say about cakes.
 *
 * This is the boundary between a renderer and a scheduler that will act on
 * whatever crosses it, unattended, for months. The bounds below are therefore
 * refusals rather than hints: an hour of 13 is not a schedule, it is a cake
 * that either never fires or fires at a time nobody chose, and the renderer's
 * picker is not the only thing that can call these methods.
 *
 * The minimum-interval refusal is the one with teeth. A cake spawns a
 * full-access agent with nobody watching, so `every 1 second` is a fork bomb
 * that a form-only check would let through the moment anything other than the
 * form called this.
 *
 * The bounds themselves now live beside the stored schemas in `cakeSchedule.ts`
 * and `cakes.ts` and are imported here. They used to be restated locally, which
 * meant the doorway refused what the storage accepted — so anything decoded
 * back out of SQLite, the path every scheduler tick takes, was unchecked.
 */

const CakeIntervalScheduleInput = Schema.Struct({
  kind: Schema.Literal("every"),
  count: CakeIntervalCount,
  unit: CakeIntervalUnit,
}).check(
  Schema.makeFilter((schedule) =>
    isCakeIntervalTooShort(schedule.count, schedule.unit)
      ? { path: ["count"], issue: CAKE_MINIMUM_INTERVAL_MESSAGE }
      : undefined,
  ),
);

const CakeAnchoredScheduleInput = Schema.Struct({
  kind: Schema.Literal("at"),
  cadence: CakeAnchorCadence,
  hour: CakeClockHour,
  meridiem: CakeMeridiem,
  timeZone: CakeTimeZone,
});

/** The schedule as a client may submit it: same union, bounded. */
export const CakeScheduleInput = Schema.Union([
  CakeIntervalScheduleInput,
  CakeAnchoredScheduleInput,
]);
export type CakeScheduleInput = typeof CakeScheduleInput.Type;

/**
 * What a client may submit, derived from what the server stores.
 *
 * The two used to be written out field for field, eight apiece, and only two of
 * them actually differed. That is a drift channel with no upside: a ninth field
 * added to `CakeConfig` would compile perfectly well while never being
 * accepted from a client, and nothing would say so.
 *
 * Spreading the stored fields and overriding the two real differences keeps the
 * stored/accepted split — which is deliberate and argued above — while making
 * "these are the same shape apart from X and Y" a fact rather than a
 * coincidence maintained by hand.
 *
 * The two differences:
 *
 * - `schedule` is the bounded union, so a client cannot submit `every 1 second`.
 * - `disallowedTools` carries no decoding default. Absent means absent on the
 *   way in; the stored schema's default is for rows written before the column
 *   existed, and applying it here would silently accept a payload that omitted
 *   the field rather than refusing it.
 */
export const CakeInput = Schema.Struct({
  ...CakeConfig.fields,
  schedule: CakeScheduleInput,
  disallowedTools: Schema.Array(Schema.String),
});
export type CakeInput = typeof CakeInput.Type;

/** Create and update are one method: the form is the same either way. */
export const CakeUpsertInput = Schema.Struct({ cake: CakeInput });
export type CakeUpsertInput = typeof CakeUpsertInput.Type;

export const CakeDeleteInput = Schema.Struct({ cakeId: CakeId });
export type CakeDeleteInput = typeof CakeDeleteInput.Type;

/**
 * Every attachment-scoped payload names the thread as well as the cake. A cake
 * can be attached to several threads at once, and disabling it on one must not
 * touch the others.
 */
const Attachment = {
  cakeId: CakeId,
  threadId: ThreadId,
};

export const CakeAttachInput = Schema.Struct(Attachment);
export type CakeAttachInput = typeof CakeAttachInput.Type;

export const CakeDetachInput = Schema.Struct(Attachment);
export type CakeDetachInput = typeof CakeDetachInput.Type;

export const CakeSetEnabledInput = Schema.Struct({
  ...Attachment,
  enabled: Schema.Boolean,
});
export type CakeSetEnabledInput = typeof CakeSetEnabledInput.Type;

/** Fire now, out of band, without disturbing the schedule's next slot. */
export const CakeRunNowInput = Schema.Struct({
  ...Attachment,
  /**
   * End the thread's provider session before the cake's turn starts.
   *
   * The drop dialog's "stop the current agent, and spawn the cake" answer, and
   * nothing else. Every other way of reaching this method — the shelf's Start
   * button, a drop onto an idle thread — is an ordinary run that must leave the
   * session alone, so the instruction is per call rather than a property of the
   * cake or of the method.
   *
   * Optional because absent is unambiguous: a caller that says nothing is
   * asking for an ordinary run. It is the *server* that must not default this
   * to true, and the *client* that should still state it at every call site.
   */
  endSessionFirst: Schema.optional(Schema.Boolean),
});
export type CakeRunNowInput = typeof CakeRunNowInput.Type;

/** Stop a running cake. It stays scheduled and returns at its next slot. */
export const CakeStopInput = Schema.Struct(Attachment);
export type CakeStopInput = typeof CakeStopInput.Type;

/**
 * A cake operation that could not find the cake it names.
 *
 * Reachable from a client: delete a cake in one window and attach it in
 * another, and the attach arrives for an id that no longer exists. The handlers
 * used to answer that with `Effect.orDie`, which turns a routine race into a
 * dead fiber — the connection's problem rather than the caller's, and nothing
 * on the wire to say what happened.
 *
 * Named for the thing that is missing rather than for the operation, because
 * every cake method can hit it and one error is easier to handle than nine.
 */
export class CakeNotFoundError extends Schema.TaggedErrorClass<CakeNotFoundError>()(
  "CakeNotFoundError",
  {
    cakeId: CakeId,
  },
) {}

/**
 * A cake operation that failed to read or write storage.
 *
 * Distinct from `CakeNotFoundError` because the two call for different
 * responses: a missing cake is the client's view being stale, and a storage
 * failure is the server being unwell. Collapsing them would tell a user to
 * refresh when the disk is full.
 */
export class CakeStorageError extends Schema.TaggedErrorClass<CakeStorageError>()(
  "CakeStorageError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
