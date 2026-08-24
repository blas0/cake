import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { CakeConfig, type CakeId } from "@t3tools/contracts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";

export type CakeConfigInput = typeof CakeConfig.Encoded;
type CakeRepositoryEffect<A> = Effect.Effect<A, ProjectionRepositoryError, SqlClient.SqlClient>;

export interface CakeAttachment {
  readonly cakeId: CakeId;
  readonly threadId: string;
  readonly enabled: boolean;
  readonly nextRunAt: string | null;
  readonly attachedAt: string;
}

/**
 * How a run ended, as `cake_runs.outcome` spells it.
 *
 * `started` is not terminal — it is written when the turn goes out and stands
 * until something closes the run. `missed` is written for a slot that was
 * skipped, and `stopped` for a run a person ended. Read as a plain string on
 * the way out, because rows written before a value existed still have to decode.
 */
export type CakeRunOutcome = "started" | "missed" | "stopped";

export interface CakeRun {
  readonly id: string;
  readonly cakeId: CakeId;
  readonly threadId: string;
  readonly scheduledFor: string;
  readonly startedAt: string | null;
  readonly outcome: string;
  readonly detail: string | null;
  /**
   * The user message id the run's `thread.turn.start` carried, or null when the
   * run started no turn (a missed slot) or predates the column.
   *
   * This is the only identifier shared between a cake run and the turn it
   * causes: the command carries no turn id, and the turn id a session reports
   * as active is minted later by the provider runtime. The turn projection
   * keeps the message id beside the turn id, which is what makes the two
   * joinable.
   */
  readonly turnMessageId: string | null;
}

export interface CakeRunInput extends Omit<CakeRun, "cakeId" | "turnMessageId" | "outcome"> {
  readonly cakeId: string;
  /**
   * Narrowed on the way in, deliberately, while `CakeRun.outcome` stays a plain
   * string on the way out.
   *
   * The asymmetry is the point. Reads have to tolerate whatever is already in
   * the table, including values written before a name existed, so widening
   * there is a compatibility requirement. Writes have no such excuse: every
   * outcome this code will ever store is one of three words known at compile
   * time, and typing the input is what stops a fourth being invented by a typo
   * that no test would catch and no read would reject.
   */
  readonly outcome: CakeRunOutcome;
  /** Omitted by a run that started no turn; stored as null. */
  readonly turnMessageId?: string | null;
}

export interface CakeRepositoryShape {
  readonly upsert: (cake: CakeConfigInput, nowIso: string) => CakeRepositoryEffect<void>;
  readonly getById: (id: string) => CakeRepositoryEffect<Option.Option<CakeConfig>>;
  readonly list: () => CakeRepositoryEffect<ReadonlyArray<CakeConfig>>;
  readonly remove: (id: string) => CakeRepositoryEffect<void>;
  readonly attach: (
    input: {
      readonly cakeId: string;
      readonly threadId: string;
      readonly nextRunAt: string | null;
    },
    nowIso: string,
  ) => CakeRepositoryEffect<void>;
  readonly detach: (input: {
    readonly cakeId: string;
    readonly threadId: string;
  }) => CakeRepositoryEffect<void>;
  readonly setEnabled: (input: {
    readonly cakeId: string;
    readonly threadId: string;
    readonly enabled: boolean;
  }) => CakeRepositoryEffect<void>;
  readonly setNextRun: (input: {
    readonly cakeId: string;
    readonly threadId: string;
    readonly nextRunAt: string | null;
  }) => CakeRepositoryEffect<void>;
  readonly listAttachmentsForThread: (
    threadId: string,
  ) => CakeRepositoryEffect<ReadonlyArray<CakeAttachment>>;
  readonly listDue: (nowIso: string) => CakeRepositoryEffect<ReadonlyArray<CakeAttachment>>;
  readonly recordRun: (run: CakeRunInput) => CakeRepositoryEffect<void>;
  /**
   * Close this cake's open run on this thread, if it has one.
   *
   * Only the newest `started` run is touched, and no-op when there is none: a
   * stop is a request about whatever is running now, and a person can press the
   * button on a thread whose run already ended without that rewriting history.
   */
  readonly markRunStopped: (input: {
    readonly cakeId: string;
    readonly threadId: string;
    readonly stoppedAt: string;
  }) => CakeRepositoryEffect<void>;
  readonly listRuns: (cakeId: string) => CakeRepositoryEffect<ReadonlyArray<CakeRun>>;
  /**
   * The cake whose run owns the turn the thread is currently running, or null.
   *
   * Resolved entirely here so no turn identity has to cross the wire: a client
   * that never saw the run — the usual case, because the scheduler starts them
   * — still gets a definite answer.
   */
  readonly activeCakeIdForThread: (threadId: string) => CakeRepositoryEffect<CakeId | null>;
}

/** @effect-expect-leaking SqlClient */
export class CakeRepository extends Context.Service<CakeRepository, CakeRepositoryShape>()(
  "t3/cakes/CakeRepository",
) {}
