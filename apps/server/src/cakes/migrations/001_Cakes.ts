import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Cakes: saved agent-loop configurations, the threads they are attached to, and
 * a record of every time one fired.
 *
 * These are plain tables rather than orchestration aggregates. The event log's
 * aggregate kinds are `project` and `thread`; adding a third would ripple
 * through the event store, projector, pipeline, receipts and `ws.ts` for what
 * is, in substance, a saved form. The work a cake causes stays event-sourced,
 * because firing one dispatches the existing `thread.turn.start` command.
 *
 * One migration, creating the final shape directly. While the feature was
 * being designed this was four — `041_Cakes` and three that reshaped it: five
 * dropped columns and seven added. That history only mattered while it was
 * happening. A fork's first migration should describe the schema it means,
 * not replay how it got there.
 *
 * Every statement is `IF NOT EXISTS`, and that is load-bearing rather than
 * defensive: a database that ran the old four already has this exact shape,
 * and this migration has to be a no-op against it. That is what lets the old
 * tracking rows be deleted instead of remapped — see `CakeMigrations.ts` for
 * why they had to go.
 *
 * The schedule is stored decomposed — a kind, then either an interval or an
 * anchor — rather than as a precomputed instant. A stored instant would be
 * wrong the moment a daylight-saving change moved the wall clock under it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS cakes (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      provider_kind TEXT NOT NULL,
      model TEXT NOT NULL,
      effort TEXT NOT NULL,
      disallowed_tools TEXT NOT NULL,
      instructions TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      schedule_kind TEXT NOT NULL DEFAULT 'at',
      interval_count INTEGER,
      interval_unit TEXT,
      anchor_cadence TEXT,
      anchor_hour INTEGER,
      anchor_meridiem TEXT,
      anchor_time_zone TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS cake_thread_attachments (
      cake_id TEXT NOT NULL REFERENCES cakes (id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at TEXT,
      attached_at TEXT NOT NULL
    )
  `;

  // One attachment per cake per thread. Dropping the same cake twice must not
  // create a second schedule firing alongside the first — an invisible loop the
  // single UI toggle cannot stop.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS cake_thread_attachments_unique
    ON cake_thread_attachments (cake_id, thread_id)
  `;

  // The scheduler's hot query is "what is due now", so it reads this.
  yield* sql`
    CREATE INDEX IF NOT EXISTS cake_thread_attachments_due
    ON cake_thread_attachments (enabled, next_run_at)
  `;

  // A missed run is a fact worth keeping. Skipping is the policy, but a loop
  // that silently did nothing for a week is indistinguishable from a broken one
  // unless the skip was written down.
  yield* sql`
    CREATE TABLE IF NOT EXISTS cake_runs (
      id TEXT PRIMARY KEY NOT NULL,
      cake_id TEXT NOT NULL REFERENCES cakes (id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      started_at TEXT,
      outcome TEXT NOT NULL,
      detail TEXT,
      turn_message_id TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS cake_runs_by_cake
    ON cake_runs (cake_id, scheduled_for)
  `;

  // "Which cake owns the turn this thread is running" is a join on this pair,
  // and it is the query that lights the Stop button.
  yield* sql`
    CREATE INDEX IF NOT EXISTS cake_runs_by_thread_turn_message
    ON cake_runs (thread_id, turn_message_id)
  `;
});
