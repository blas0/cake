import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  CakeAnchorCadence,
  CakeConfig,
  CakeId,
  CakeIntervalUnit,
  CakeMeridiem,
  ProviderDriverKind,
  TrimmedNonEmptyString,
  type CakeSchedule,
} from "@t3tools/contracts";
import { nextRunAfter } from "@t3tools/shared/cakeSchedule";
import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { CakeRepository, type CakeAttachment, type CakeRepositoryShape } from "./CakeRepository.ts";

const CakeIdentityColumns = {
  id: CakeId,
  name: TrimmedNonEmptyString,
  providerKind: ProviderDriverKind,
  model: TrimmedNonEmptyString,
  effort: Schema.String,
  disallowedTools: Schema.fromJsonString(Schema.Array(Schema.String)),
  instructions: TrimmedNonEmptyString,
};

/**
 * A cake row as one of the two schedule modes, never as a bag of nullable
 * columns.
 *
 * The union arms are what turn "these columns happen to be filled in" into a
 * decodable schedule. A single struct with every column nullable would push the
 * question of which fields are real into the mapping function, where a row half
 * -written by a future migration would decode into a schedule the scheduler
 * silently misreads rather than a failure someone can see.
 */
const CakeIntervalRow = Schema.Struct({
  ...CakeIdentityColumns,
  scheduleKind: Schema.Literal("every"),
  intervalCount: Schema.Number,
  intervalUnit: CakeIntervalUnit,
});

const CakeAnchoredRow = Schema.Struct({
  ...CakeIdentityColumns,
  scheduleKind: Schema.Literal("at"),
  anchorCadence: CakeAnchorCadence,
  anchorHour: Schema.Number,
  anchorMeridiem: CakeMeridiem,
  anchorTimeZone: Schema.String,
});

const CakeRow = Schema.Union([CakeIntervalRow, CakeAnchoredRow]);
type CakeRow = typeof CakeRow.Type;

const CakeAttachmentRow = Schema.Struct({
  cakeId: CakeId,
  threadId: Schema.String,
  enabled: Schema.Number,
  nextRunAt: Schema.NullOr(Schema.String),
  attachedAt: Schema.String,
});
type CakeAttachmentRow = typeof CakeAttachmentRow.Type;

const CakeRunRow = Schema.Struct({
  id: Schema.String,
  cakeId: CakeId,
  threadId: Schema.String,
  scheduledFor: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  outcome: Schema.String,
  detail: Schema.NullOr(Schema.String),
  turnMessageId: Schema.NullOr(Schema.String),
});

const ActiveCakeRow = Schema.Struct({ cakeId: CakeId });

const decodeCakeConfigInput = Schema.decodeUnknownEffect(CakeConfig);
const decodeCakeRunInput = Schema.decodeUnknownEffect(CakeRunRow);

const IdRequest = Schema.Struct({ id: Schema.String });
const ThreadRequest = Schema.Struct({ threadId: Schema.String });
const CakeIdRequest = Schema.Struct({ cakeId: Schema.String });
const AttachmentKeyRequest = Schema.Struct({ cakeId: Schema.String, threadId: Schema.String });
const DueRequest = Schema.Struct({ nowIso: Schema.String });

function decodeSchedule(row: CakeRow): CakeSchedule {
  return row.scheduleKind === "every"
    ? { kind: "every", count: row.intervalCount, unit: row.intervalUnit }
    : {
        kind: "at",
        cadence: row.anchorCadence,
        hour: row.anchorHour,
        meridiem: row.anchorMeridiem,
        timeZone: row.anchorTimeZone,
      };
}

function decodeCake(row: CakeRow): CakeConfig {
  return {
    id: row.id,
    name: row.name,
    providerKind: row.providerKind,
    model: row.model,
    effort: row.effort,
    schedule: decodeSchedule(row),
    disallowedTools: row.disallowedTools,
    instructions: row.instructions,
  };
}

/**
 * The schedule flattened into the columns it is stored in.
 *
 * Every column of the mode that is not in use is written as NULL rather than
 * left at whatever the previous save put there. A stale interval count sitting
 * beside an anchored schedule is exactly the kind of half-truth the row union
 * above exists to refuse.
 */
function scheduleColumns(schedule: CakeSchedule): {
  readonly kind: string;
  readonly intervalCount: number | null;
  readonly intervalUnit: string | null;
  readonly anchorCadence: string | null;
  readonly anchorHour: number | null;
  readonly anchorMeridiem: string | null;
  readonly anchorTimeZone: string | null;
} {
  return schedule.kind === "every"
    ? {
        kind: "every",
        intervalCount: schedule.count,
        intervalUnit: schedule.unit,
        anchorCadence: null,
        anchorHour: null,
        anchorMeridiem: null,
        anchorTimeZone: null,
      }
    : {
        kind: "at",
        intervalCount: null,
        intervalUnit: null,
        anchorCadence: schedule.cadence,
        anchorHour: schedule.hour,
        anchorMeridiem: schedule.meridiem,
        anchorTimeZone: schedule.timeZone,
      };
}

function decodeAttachment(row: CakeAttachmentRow): CakeAttachment {
  return { ...row, enabled: row.enabled === 1 };
}

const makeCakeRepository = (sql: SqlClient.SqlClient): CakeRepositoryShape => {
  const upsertCake = SqlSchema.void({
    Request: Schema.Struct({ cake: CakeConfig, nowIso: Schema.String }),
    execute: ({ cake, nowIso }) => {
      const schedule = scheduleColumns(cake.schedule);
      return sql`
        INSERT INTO cakes (
          id, name, provider_kind, model, effort, schedule_kind,
          interval_count, interval_unit, anchor_cadence, anchor_hour,
          anchor_meridiem, anchor_time_zone, disallowed_tools,
          instructions, created_at, updated_at
        ) VALUES (
          ${cake.id}, ${cake.name}, ${cake.providerKind}, ${cake.model}, ${cake.effort},
          ${schedule.kind}, ${schedule.intervalCount}, ${schedule.intervalUnit},
          ${schedule.anchorCadence}, ${schedule.anchorHour}, ${schedule.anchorMeridiem},
          ${schedule.anchorTimeZone}, ${JSON.stringify(cake.disallowedTools)},
          ${cake.instructions}, ${nowIso}, ${nowIso}
        )
        ON CONFLICT (id) DO UPDATE SET
          name = excluded.name,
          provider_kind = excluded.provider_kind,
          model = excluded.model,
          effort = excluded.effort,
          schedule_kind = excluded.schedule_kind,
          interval_count = excluded.interval_count,
          interval_unit = excluded.interval_unit,
          anchor_cadence = excluded.anchor_cadence,
          anchor_hour = excluded.anchor_hour,
          anchor_meridiem = excluded.anchor_meridiem,
          anchor_time_zone = excluded.anchor_time_zone,
          disallowed_tools = excluded.disallowed_tools,
          instructions = excluded.instructions,
          updated_at = excluded.updated_at
      `;
    },
  });

  const rescheduleAttachmentsIfScheduleChanged = SqlSchema.void({
    Request: Schema.Struct({ cake: CakeConfig, nextRunAt: Schema.String }),
    execute: ({ cake, nextRunAt }) => {
      const schedule = scheduleColumns(cake.schedule);
      return sql`
        UPDATE cake_thread_attachments
        SET next_run_at = ${nextRunAt}
        WHERE cake_id = ${cake.id}
          AND next_run_at IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM cakes
            WHERE id = ${cake.id}
              AND (
                schedule_kind IS NOT ${schedule.kind}
                OR interval_count IS NOT ${schedule.intervalCount}
                OR interval_unit IS NOT ${schedule.intervalUnit}
                OR anchor_cadence IS NOT ${schedule.anchorCadence}
                OR anchor_hour IS NOT ${schedule.anchorHour}
                OR anchor_meridiem IS NOT ${schedule.anchorMeridiem}
                OR anchor_time_zone IS NOT ${schedule.anchorTimeZone}
              )
          )
      `;
    },
  });

  const selectCake = SqlSchema.findOneOption({
    Request: IdRequest,
    Result: CakeRow,
    execute: ({ id }) => sql`
      SELECT id, name, provider_kind AS "providerKind", model, effort,
        schedule_kind AS "scheduleKind", interval_count AS "intervalCount",
        interval_unit AS "intervalUnit", anchor_cadence AS "anchorCadence",
        anchor_hour AS "anchorHour", anchor_meridiem AS "anchorMeridiem",
        anchor_time_zone AS "anchorTimeZone",
        disallowed_tools AS "disallowedTools", instructions
      FROM cakes
      WHERE id = ${id}
    `,
  });

  const selectCakes = SqlSchema.findAll({
    Request: Schema.Void,
    Result: CakeRow,
    execute: () => sql`
      SELECT id, name, provider_kind AS "providerKind", model, effort,
        schedule_kind AS "scheduleKind", interval_count AS "intervalCount",
        interval_unit AS "intervalUnit", anchor_cadence AS "anchorCadence",
        anchor_hour AS "anchorHour", anchor_meridiem AS "anchorMeridiem",
        anchor_time_zone AS "anchorTimeZone",
        disallowed_tools AS "disallowedTools", instructions
      FROM cakes
      ORDER BY created_at ASC, id ASC
    `,
  });

  const deleteCake = SqlSchema.void({
    Request: IdRequest,
    execute: ({ id }) => sql`DELETE FROM cakes WHERE id = ${id}`,
  });

  const attachCake = SqlSchema.void({
    Request: Schema.Struct({
      cakeId: Schema.String,
      threadId: Schema.String,
      nextRunAt: Schema.NullOr(Schema.String),
      nowIso: Schema.String,
    }),
    execute: ({ cakeId, threadId, nextRunAt, nowIso }) => sql`
      INSERT INTO cake_thread_attachments (
        cake_id, thread_id, enabled, next_run_at, attached_at
      ) VALUES (${cakeId}, ${threadId}, 1, ${nextRunAt}, ${nowIso})
      ON CONFLICT (cake_id, thread_id) DO NOTHING
    `,
  });

  const detachCake = SqlSchema.void({
    Request: AttachmentKeyRequest,
    execute: ({ cakeId, threadId }) => sql`
      DELETE FROM cake_thread_attachments
      WHERE cake_id = ${cakeId} AND thread_id = ${threadId}
    `,
  });

  const updateEnabled = SqlSchema.void({
    Request: Schema.Struct({
      cakeId: Schema.String,
      threadId: Schema.String,
      enabled: Schema.Boolean,
    }),
    execute: ({ cakeId, threadId, enabled }) => sql`
      UPDATE cake_thread_attachments
      SET enabled = ${enabled ? 1 : 0}
      WHERE cake_id = ${cakeId} AND thread_id = ${threadId}
    `,
  });

  const updateNextRun = SqlSchema.void({
    Request: Schema.Struct({
      cakeId: Schema.String,
      threadId: Schema.String,
      nextRunAt: Schema.NullOr(Schema.String),
    }),
    execute: ({ cakeId, threadId, nextRunAt }) => sql`
      UPDATE cake_thread_attachments
      SET next_run_at = ${nextRunAt}
      WHERE cake_id = ${cakeId} AND thread_id = ${threadId}
    `,
  });

  const attachmentColumns = sql`
    cake_id AS "cakeId", thread_id AS "threadId", enabled,
    next_run_at AS "nextRunAt", attached_at AS "attachedAt"
  `;

  const selectAttachmentsForThread = SqlSchema.findAll({
    Request: ThreadRequest,
    Result: CakeAttachmentRow,
    execute: ({ threadId }) => sql`
      SELECT ${attachmentColumns}
      FROM cake_thread_attachments
      WHERE thread_id = ${threadId}
      ORDER BY attached_at ASC, cake_id ASC
    `,
  });

  const selectDue = SqlSchema.findAll({
    Request: DueRequest,
    Result: CakeAttachmentRow,
    execute: ({ nowIso }) => sql`
      SELECT ${attachmentColumns}
      FROM cake_thread_attachments
      WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ${nowIso}
      ORDER BY next_run_at ASC, cake_id ASC, thread_id ASC
    `,
  });

  const insertRun = SqlSchema.void({
    Request: CakeRunRow,
    execute: (run) => sql`
      INSERT INTO cake_runs (
        id, cake_id, thread_id, scheduled_for, started_at, outcome, detail, turn_message_id
      ) VALUES (
        ${run.id}, ${run.cakeId}, ${run.threadId}, ${run.scheduledFor},
        ${run.startedAt}, ${run.outcome}, ${run.detail}, ${run.turnMessageId}
      )
    `,
  });

  /**
   * The newest open run only, chosen by the same ordering the active-cake
   * lookup uses. An older `started` row is either already closed or belongs to
   * a run nothing is offering to stop, and rewriting it would turn a history of
   * what happened into a history of what was clicked.
   */
  const closeOpenRun = SqlSchema.void({
    Request: Schema.Struct({
      cakeId: Schema.String,
      threadId: Schema.String,
      stoppedAt: Schema.String,
    }),
    execute: ({ cakeId, threadId, stoppedAt }) => sql`
      UPDATE cake_runs
      SET outcome = 'stopped', detail = ${`stopped at ${stoppedAt}`}
      WHERE id = (
        SELECT id FROM cake_runs
        WHERE cake_id = ${cakeId} AND thread_id = ${threadId} AND outcome = 'started'
        ORDER BY scheduled_for DESC, id DESC
        LIMIT 1
      )
    `,
  });

  const selectRuns = SqlSchema.findAll({
    Request: CakeIdRequest,
    Result: CakeRunRow,
    execute: ({ cakeId }) => sql`
      SELECT id, cake_id AS "cakeId", thread_id AS "threadId",
        scheduled_for AS "scheduledFor", started_at AS "startedAt", outcome, detail,
        turn_message_id AS "turnMessageId"
      FROM cake_runs
      WHERE cake_id = ${cakeId}
      ORDER BY scheduled_for ASC, id ASC
    `,
  });

  /**
   * Which cake, if any, owns the turn this thread is running.
   *
   * The chain is the only one that exists. A run wrote down the message id its
   * `thread.turn.start` carried; the turn projection kept that message id
   * beside the turn id the provider runtime later minted; the session names one
   * of those turn ids as active. Anything looser — "the thread is busy and a
   * cake is attached" — would offer to stop a cake while the user's own turn is
   * running.
   */
  const selectActiveCake = SqlSchema.findOneOption({
    Request: ThreadRequest,
    Result: ActiveCakeRow,
    execute: ({ threadId }) => sql`
      SELECT cake_runs.cake_id AS "cakeId"
      FROM cake_runs
      JOIN projection_turns
        ON projection_turns.thread_id = cake_runs.thread_id
        AND projection_turns.pending_message_id = cake_runs.turn_message_id
      JOIN projection_thread_sessions
        ON projection_thread_sessions.thread_id = projection_turns.thread_id
        AND projection_thread_sessions.active_turn_id = projection_turns.turn_id
      WHERE cake_runs.thread_id = ${threadId}
        AND cake_runs.turn_message_id IS NOT NULL
        AND projection_turns.turn_id IS NOT NULL
        AND projection_thread_sessions.status = 'running'
      ORDER BY cake_runs.scheduled_for DESC, cake_runs.id DESC
      LIMIT 1
    `,
  });

  const mapError = (operation: string) => Effect.mapError(toPersistenceSqlError(operation));

  const upsert: CakeRepositoryShape["upsert"] = (cake, nowIso) =>
    decodeCakeConfigInput(cake).pipe(
      Effect.flatMap((decoded) => {
        const now = DateTime.toEpochMillis(DateTime.makeUnsafe(nowIso));
        const nextRunAt = DateTime.formatIso(
          DateTime.makeUnsafe(nextRunAfter(decoded.schedule, now)),
        );
        return sql.withTransaction(
          rescheduleAttachmentsIfScheduleChanged({ cake: decoded, nextRunAt }).pipe(
            Effect.flatMap(() => upsertCake({ cake: decoded, nowIso })),
          ),
        );
      }),
      mapError("CakeRepository.upsert:query"),
    );
  const getById: CakeRepositoryShape["getById"] = (id) =>
    selectCake({ id }).pipe(
      mapError("CakeRepository.getById:query"),
      Effect.map(Option.map(decodeCake)),
    );
  const list: CakeRepositoryShape["list"] = () =>
    selectCakes(undefined).pipe(
      mapError("CakeRepository.list:query"),
      Effect.map((rows) => rows.map(decodeCake)),
    );
  const remove: CakeRepositoryShape["remove"] = (id) =>
    deleteCake({ id }).pipe(mapError("CakeRepository.remove:query"));
  const attach: CakeRepositoryShape["attach"] = (input, nowIso) =>
    attachCake({ ...input, nowIso }).pipe(mapError("CakeRepository.attach:query"));
  const detach: CakeRepositoryShape["detach"] = (input) =>
    detachCake(input).pipe(mapError("CakeRepository.detach:query"));
  const setEnabled: CakeRepositoryShape["setEnabled"] = (input) =>
    updateEnabled(input).pipe(mapError("CakeRepository.setEnabled:query"));
  const setNextRun: CakeRepositoryShape["setNextRun"] = (input) =>
    updateNextRun(input).pipe(mapError("CakeRepository.setNextRun:query"));
  const listAttachmentsForThread: CakeRepositoryShape["listAttachmentsForThread"] = (threadId) =>
    selectAttachmentsForThread({ threadId }).pipe(
      mapError("CakeRepository.listAttachmentsForThread:query"),
      Effect.map((rows) => rows.map(decodeAttachment)),
    );
  const listDue: CakeRepositoryShape["listDue"] = (nowIso) =>
    selectDue({ nowIso }).pipe(
      mapError("CakeRepository.listDue:query"),
      Effect.map((rows) => rows.map(decodeAttachment)),
    );
  const recordRun: CakeRepositoryShape["recordRun"] = (run) =>
    decodeCakeRunInput({ ...run, turnMessageId: run.turnMessageId ?? null }).pipe(
      Effect.flatMap(insertRun),
      mapError("CakeRepository.recordRun:query"),
    );
  const markRunStopped: CakeRepositoryShape["markRunStopped"] = (input) =>
    closeOpenRun(input).pipe(mapError("CakeRepository.markRunStopped:query"));
  const listRuns: CakeRepositoryShape["listRuns"] = (cakeId) =>
    selectRuns({ cakeId }).pipe(mapError("CakeRepository.listRuns:query"));
  const activeCakeIdForThread: CakeRepositoryShape["activeCakeIdForThread"] = (threadId) =>
    selectActiveCake({ threadId }).pipe(
      mapError("CakeRepository.activeCakeIdForThread:query"),
      Effect.map(Option.match({ onNone: () => null, onSome: (row) => row.cakeId })),
    );

  return {
    upsert,
    getById,
    list,
    remove,
    attach,
    detach,
    setEnabled,
    setNextRun,
    listAttachmentsForThread,
    listDue,
    recordRun,
    markRunStopped,
    listRuns,
    activeCakeIdForThread,
  } satisfies CakeRepositoryShape;
};

/**
 * The layer, built the way every other repository in this tree is built.
 *
 * This used to memoize repositories in a module-level
 * `WeakMap<SqlClient, CakeRepositoryShape>` and thread each of the fourteen
 * methods through a `useRepository` lookup, which left `SqlClient` in the
 * requirements of every call. That was a cache reimplementing the thing the
 * layer system already is: `Layer.effect` builds once, when the layer is built,
 * and hands out the same service to everyone who asks — no keying, no eviction
 * question, and no `SqlClient` leaking into the shape's requirements.
 *
 * See `persistence/Layers/ProjectionThreads.ts` for the same construction.
 */
export const CakeRepositoryLive = Layer.effect(
  CakeRepository,
  Effect.map(SqlClient.SqlClient, makeCakeRepository),
);
