import type { CakeConfig } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { cakeAttachmentKey, planCakeTickEffects, type PlannedTurnStart } from "./applyCakeTick.ts";
import { CakeRepository, type CakeAttachment } from "./CakeRepository.ts";
import type { CakeRunRequest } from "./cakeRunThread.ts";
import { decideCakeTick } from "./cakeTick.ts";

const isoFromEpochMillis = (value: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(value));

/**
 * Why a scheduled turn failed to reach a provider.
 *
 * Tagged rather than a bare `Error` because this failure is logged and swallowed
 * — the tick must survive one bad cake — and an untagged channel would let any
 * unrelated defect merge into the same branch and be logged as a start failure.
 */
export class CakeTurnStartError extends Schema.TaggedErrorClass<CakeTurnStartError>()(
  "CakeTurnStartError",
  {
    cakeId: Schema.String,
    threadId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Cake ${this.cakeId} could not start a turn on thread ${this.threadId}: ${this.detail}`;
  }
}

export interface CakeTurnStarter {
  /**
   * Which thread this cake's turn can actually be started on.
   *
   * Separate from `startTurn`, and run before anything is written down, because
   * the answer decides what gets written: the run row and the turn's message id
   * both name the thread the work really happens in, and they are the two sides
   * of the join that lights "Stop Cake".
   *
   * May create a thread. See `resolveCakeRunThread`, which is what every
   * implementation of this delegates to.
   */
  readonly resolveRunThread: (input: CakeRunRequest) => Effect.Effect<string, CakeTurnStartError>;
  readonly startTurn: (input: PlannedTurnStart) => Effect.Effect<void, CakeTurnStartError>;
}

export const runCakeTickOnce = Effect.fn("runCakeTickOnce")(function* (input: {
  readonly now: number;
  readonly shouldRunOpportunisticWork: boolean;
  readonly starter: CakeTurnStarter;
  /**
   * The attachments to treat as due, instead of asking the repository.
   *
   * Run now supplies exactly one — the person pressing the button is that run's
   * schedule. It used to say so by handing this function a cloned
   * `CakeRepository` whose `listDue` returned that attachment and whose
   * `setNextRun` did nothing, which made a button press impersonate a tick.
   * That coupled the two: every repository call added here would have silently
   * reached the real implementation through a service the caller believed it
   * had replaced. Two named inputs cannot drift that way.
   */
  readonly dueOverride?: ReadonlyArray<CakeAttachment> | undefined;
  /**
   * Whether firing a slot moves the schedule on. False for a manual run, which
   * happens outside the schedule and must not consume the next slot.
   */
  readonly advanceSlots?: boolean | undefined;
}) {
  const repository = yield* CakeRepository;
  const dueAttachments =
    input.dueOverride ?? (yield* repository.listDue(isoFromEpochMillis(input.now)));
  const cakeIds = new Set(dueAttachments.map((attachment) => attachment.cakeId));
  const loadedCakes = yield* Effect.forEach(cakeIds, (cakeId) => repository.getById(cakeId));
  // Keyed by plain string, because a decision names its cake as one: the
  // branded id is the repository's, and re-branding a value that came back out
  // of it would be a cast dressed up as a check.
  const cakesById = new Map<string, CakeConfig>(
    loadedCakes.flatMap((cake) =>
      Option.toArray(Option.map(cake, (value) => [value.id, value] as const)),
    ),
  );
  const due = dueAttachments.flatMap((attachment) => {
    const cake = cakesById.get(attachment.cakeId);
    if (cake === undefined || attachment.nextRunAt === null) return [];
    return [
      {
        cakeId: attachment.cakeId,
        threadId: attachment.threadId,
        nextRunAt: DateTime.toEpochMillis(DateTime.makeUnsafe(attachment.nextRunAt)),
        schedule: cake.schedule,
      },
    ];
  });
  const decisions = decideCakeTick({
    now: input.now,
    shouldRunOpportunisticWork: input.shouldRunOpportunisticWork,
    due,
  });
  /**
   * Where each firing cake's turn will really run.
   *
   * Resolved before the plan rather than at dispatch time because the plan is
   * what records the run, and a run recorded against one thread while its turn
   * starts in another is a run permanently unlinked from the turn it caused —
   * "Stop Cake" never lights, and nothing errors to say why.
   *
   * A failure here is logged and left out of the map. The planner then sends
   * the turn to the attached thread, which is where it would have gone before
   * any of this existed: either it runs, or the dispatch reports the real
   * reason. Dropping the cake instead would be a loop that silently stopped.
   */
  const runThreads = new Map<string, string>();
  yield* Effect.forEach(
    decisions,
    (decision) => {
      if (decision.kind !== "fire") return Effect.void;
      const cake = cakesById.get(decision.cakeId);
      if (cake === undefined) return Effect.void;
      return input.starter
        .resolveRunThread({
          cakeId: cake.id,
          cakeName: cake.name,
          threadId: decision.threadId,
          instanceId: cake.providerKind,
          model: cake.model,
        })
        .pipe(
          Effect.flatMap((threadId) =>
            Effect.sync(() => {
              runThreads.set(
                cakeAttachmentKey({ cakeId: decision.cakeId, threadId: decision.threadId }),
                threadId,
              );
            }),
          ),
          Effect.catch((error) =>
            Effect.logWarning("cake run thread could not be resolved", {
              cakeId: decision.cakeId,
              threadId: decision.threadId,
              error,
            }),
          ),
        );
    },
    { discard: true },
  );
  const plan = planCakeTickEffects({ decisions, cakesById, runThreads, now: input.now });

  // Advancing every claimed slot first keeps a following tick from observing
  // work that this tick has already committed to start. A manual run skips it:
  // pressing Start is not the schedule firing, and consuming the next slot
  // would make the button quietly cancel the run it was standing in for.
  yield* Effect.forEach(
    input.advanceSlots === false ? [] : plan.slotUpdates,
    (update) =>
      repository.setNextRun({
        cakeId: update.cakeId,
        threadId: update.threadId,
        nextRunAt: isoFromEpochMillis(update.nextRunAt),
      }),
    { discard: true },
  );
  yield* Effect.forEach(
    plan.runs,
    (run) =>
      repository.recordRun({
        id: JSON.stringify([run.cakeId, run.threadId, run.scheduledFor]),
        cakeId: run.cakeId,
        threadId: run.threadId,
        scheduledFor: isoFromEpochMillis(run.scheduledFor),
        startedAt: run.startedAt === null ? null : isoFromEpochMillis(run.startedAt),
        outcome: run.outcome,
        detail: run.detail,
        turnMessageId: run.turnMessageId,
      }),
    { discard: true },
  );
  yield* Effect.forEach(
    plan.turns,
    (turn) =>
      input.starter.startTurn(turn).pipe(
        Effect.catch((error) =>
          Effect.logWarning("cake schedule turn failed to start", {
            cakeId: turn.cakeId,
            threadId: turn.threadId,
            error,
          }),
        ),
      ),
    { discard: true },
  );
});

export interface CakeScheduleReactorShape {
  /**
   * Fork the periodic tick.
   *
   * Shaped like every other orchestration reactor's `start` — scoped, so the
   * tick fiber is finalized on shutdown — because that is what puts it in
   * `OrchestrationReactor`'s list. A scheduler that starts itself as a side
   * effect of a layer being built is a scheduler nothing has to remember to
   * start, and also one nothing fails to compile without.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class CakeScheduleReactor extends Context.Service<
  CakeScheduleReactor,
  CakeScheduleReactorShape
>()("t3/cakes/CakeScheduleReactor") {}
