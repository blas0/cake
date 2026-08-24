import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import { runCakeMigrations } from "./CakeMigrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { CakeRepository } from "./CakeRepository.ts";
import { CakeRepositoryLive } from "./CakeRepositoryLive.ts";

/**
 * The store a scheduler reads every tick, unattended, for months.
 *
 * The interesting behaviour is not "can it round-trip a row" but what happens
 * at the edges the UI can reach: the same cake dropped twice, a cake deleted
 * while attached, a run that was skipped rather than executed. Each of those is
 * a state the scheduler will meet and must not be surprised by.
 */

const layer = it.layer(CakeRepositoryLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())));

const NOW = "2026-01-01T00:00:00.000Z";

const sampleCake = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: `Cake ${id}`,
  providerKind: "claudeAgent",
  model: "claude-opus-5",
  effort: "high",
  schedule: {
    kind: "at" as const,
    cadence: "day" as const,
    hour: 9,
    meridiem: "AM" as const,
    timeZone: "America/New_York",
  },
  disallowedTools: [] as ReadonlyArray<string>,
  instructions: "# CAKE.md\n\nDo the loop.",
  ...overrides,
});

layer("CakeRepository", (it) => {
  /**
   * `it.layer` shares one in-memory database across every case in the block, so
   * rows written by one test are visible to the next. Each test therefore
   * starts from empty tables — otherwise assertions about counts and due sets
   * pass or fail depending on which tests ran before them, which is a suite
   * that lies in both directions.
   */
  const migrate = Effect.gen(function* () {
    yield* runMigrations({});
    yield* runCakeMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM cake_runs`;
    yield* sql`DELETE FROM cake_thread_attachments`;
    yield* sql`DELETE FROM cakes`;
  });

  it.effect("round-trips a cake", () =>
    Effect.gen(function* () {
      yield* migrate;
      const repo = yield* CakeRepository;

      yield* repo.upsert(sampleCake("cake-1"), NOW);
      const found = yield* repo.getById("cake-1");

      assert.isTrue(Option.isSome(found));
      const cake = Option.getOrThrow(found);
      assert.equal(cake.name, "Cake cake-1");
      // Narrowed rather than asserted: the interval arm of the schedule union
      // has no timezone at all, so reaching for one would be checking a field
      // that cannot exist rather than failing honestly.
      assert.equal(cake.schedule.kind, "at");
      if (cake.schedule.kind !== "at") throw new Error("expected an anchored schedule");
      assert.equal(cake.schedule.timeZone, "America/New_York");
      assert.equal(cake.schedule.hour, 9);
      assert.equal(cake.schedule.meridiem, "AM");
    }),
  );

  it.effect("lists cakes for the settings page", () =>
    Effect.gen(function* () {
      yield* migrate;
      const repo = yield* CakeRepository;

      yield* repo.upsert(sampleCake("cake-1"), NOW);
      yield* repo.upsert(sampleCake("cake-2"), NOW);

      const all = yield* repo.list();
      assert.deepEqual(all.map((cake) => cake.id).toSorted(), ["cake-1", "cake-2"]);
    }),
  );

  it.effect("updates a cake in place rather than duplicating it", () =>
    Effect.gen(function* () {
      yield* migrate;
      const repo = yield* CakeRepository;

      yield* repo.upsert(sampleCake("cake-1"), NOW);
      yield* repo.upsert(sampleCake("cake-1", { name: "Renamed" }), NOW);

      const all = yield* repo.list();
      assert.equal(all.length, 1);
      assert.equal(all[0]?.name, "Renamed");
    }),
  );

  it.effect("reschedules attached cakes when their schedule changes", () =>
    Effect.gen(function* () {
      yield* migrate;
      const repo = yield* CakeRepository;

      yield* repo.upsert(sampleCake("cake-1"), NOW);
      yield* repo.attach(
        {
          cakeId: "cake-1",
          threadId: "thread-1",
          nextRunAt: "2026-01-01T14:00:00.000Z",
        },
        NOW,
      );

      yield* repo.upsert(
        sampleCake("cake-1", {
          schedule: {
            kind: "at",
            cadence: "day",
            hour: 10,
            meridiem: "AM",
            timeZone: "America/New_York",
          },
        }),
        NOW,
      );

      const attachments = yield* repo.listAttachmentsForThread("thread-1");
      assert.equal(attachments[0]?.nextRunAt, "2026-01-01T15:00:00.000Z");
    }),
  );

  it.effect("keeps fork-only attachments unscheduled when a cake changes", () =>
    Effect.gen(function* () {
      yield* migrate;
      const repo = yield* CakeRepository;

      yield* repo.upsert(sampleCake("cake-1"), NOW);
      yield* repo.attach({ cakeId: "cake-1", threadId: "thread-fork", nextRunAt: null }, NOW);

      yield* repo.upsert(
        sampleCake("cake-1", {
          schedule: {
            kind: "at",
            cadence: "day",
            hour: 10,
            meridiem: "AM",
            timeZone: "America/New_York",
          },
        }),
        NOW,
      );

      const attachments = yield* repo.listAttachmentsForThread("thread-fork");
      assert.isNull(attachments[0]?.nextRunAt);
    }),
  );

  /**
   * Dropping the same cake on the same thread twice is an ordinary thing for a
   * user to do. It must leave one schedule, not two firing in lockstep — the
   * second would be invisible in the UI and unstoppable by its single toggle.
   */
  it.effect("attaching the same cake to a thread twice leaves one attachment", () =>
    Effect.gen(function* () {
      yield* migrate;
      const repo = yield* CakeRepository;

      yield* repo.upsert(sampleCake("cake-1"), NOW);
      yield* repo.attach({ cakeId: "cake-1", threadId: "thread-1", nextRunAt: NOW }, NOW);
      yield* repo.attach({ cakeId: "cake-1", threadId: "thread-1", nextRunAt: NOW }, NOW);

      const attachments = yield* repo.listAttachmentsForThread("thread-1");
      assert.equal(attachments.length, 1);
    }),
  );

  it.effect("detaching removes the schedule without deleting the cake", () =>
    Effect.gen(function* () {
      yield* migrate;
      const repo = yield* CakeRepository;

      yield* repo.upsert(sampleCake("cake-1"), NOW);
      yield* repo.attach({ cakeId: "cake-1", threadId: "thread-1", nextRunAt: NOW }, NOW);
      yield* repo.detach({ cakeId: "cake-1", threadId: "thread-1" });

      assert.equal((yield* repo.listAttachmentsForThread("thread-1")).length, 0);
      assert.isTrue(Option.isSome(yield* repo.getById("cake-1")));
    }),
  );

  /**
   * The composer's Cakes toggle disables a loop without forgetting it. A
   * disabled attachment keeps its row so re-enabling restores the same
   * schedule, and must never come back from the due query meanwhile.
   */
  it.effect("a disabled attachment is never due", () =>
    Effect.gen(function* () {
      yield* migrate;
      const repo = yield* CakeRepository;

      yield* repo.upsert(sampleCake("cake-1"), NOW);
      yield* repo.attach(
        { cakeId: "cake-1", threadId: "thread-1", nextRunAt: "2026-01-01T00:00:00.000Z" },
        NOW,
      );
      yield* repo.setEnabled({ cakeId: "cake-1", threadId: "thread-1", enabled: false });

      const due = yield* repo.listDue("2026-06-01T00:00:00.000Z");
      assert.equal(due.length, 0);

      yield* repo.setEnabled({ cakeId: "cake-1", threadId: "thread-1", enabled: true });
      assert.equal((yield* repo.listDue("2026-06-01T00:00:00.000Z")).length, 1);
    }),
  );

  it.effect("only returns attachments whose slot has arrived", () =>
    Effect.gen(function* () {
      yield* migrate;
      const repo = yield* CakeRepository;

      yield* repo.upsert(sampleCake("cake-1"), NOW);
      yield* repo.attach(
        { cakeId: "cake-1", threadId: "past", nextRunAt: "2026-01-01T00:00:00.000Z" },
        NOW,
      );
      yield* repo.attach(
        { cakeId: "cake-1", threadId: "future", nextRunAt: "2026-12-01T00:00:00.000Z" },
        NOW,
      );

      const due = yield* repo.listDue("2026-06-01T00:00:00.000Z");
      assert.deepEqual(
        due.map((entry) => entry.threadId),
        ["past"],
      );
    }),
  );

  it.effect("advancing a slot moves it out of the due set", () =>
    Effect.gen(function* () {
      yield* migrate;
      const repo = yield* CakeRepository;

      yield* repo.upsert(sampleCake("cake-1"), NOW);
      yield* repo.attach(
        { cakeId: "cake-1", threadId: "thread-1", nextRunAt: "2026-01-01T00:00:00.000Z" },
        NOW,
      );
      yield* repo.setNextRun({
        cakeId: "cake-1",
        threadId: "thread-1",
        nextRunAt: "2026-12-01T00:00:00.000Z",
      });

      assert.equal((yield* repo.listDue("2026-06-01T00:00:00.000Z")).length, 0);
    }),
  );

  /**
   * Skipping a missed slot is the policy; recording it is what makes the policy
   * legible. A loop that quietly did nothing for a week looks exactly like a
   * broken one unless the skip was written down.
   */
  it.effect("records a run and its outcome", () =>
    Effect.gen(function* () {
      yield* migrate;
      const repo = yield* CakeRepository;

      yield* repo.upsert(sampleCake("cake-1"), NOW);
      yield* repo.recordRun({
        id: "run-1",
        cakeId: "cake-1",
        threadId: "thread-1",
        scheduledFor: "2026-01-01T09:00:00.000Z",
        startedAt: "2026-01-01T09:00:01.000Z",
        outcome: "started",
        detail: null,
      });
      yield* repo.recordRun({
        id: "run-2",
        cakeId: "cake-1",
        threadId: "thread-1",
        scheduledFor: "2026-01-02T09:00:00.000Z",
        startedAt: null,
        outcome: "missed",
        detail: "server was not running",
      });

      const runs = yield* repo.listRuns("cake-1");
      assert.deepEqual(runs.map((run) => run.outcome).toSorted(), ["missed", "started"]);
    }),
  );

  /**
   * `started` is not an ending. Until something writes a terminal outcome, a
   * run that was stopped, one still going and one whose server died all read
   * back the same, so run history can only ever say a cake fired.
   */
  it.effect("closes the open run when a cake is stopped", () =>
    Effect.gen(function* () {
      yield* migrate;
      const repo = yield* CakeRepository;

      yield* repo.upsert(sampleCake("cake-1"), NOW);
      yield* repo.recordRun({
        id: "run-1",
        cakeId: "cake-1",
        threadId: "thread-1",
        scheduledFor: "2026-01-01T09:00:00.000Z",
        startedAt: "2026-01-01T09:00:01.000Z",
        outcome: "started",
        detail: null,
      });

      yield* repo.markRunStopped({
        cakeId: "cake-1",
        threadId: "thread-1",
        stoppedAt: "2026-01-01T09:30:00.000Z",
      });

      const runs = yield* repo.listRuns("cake-1");
      assert.equal(runs[0]?.outcome, "stopped");
      assert.include(runs[0]?.detail ?? "", "2026-01-01T09:30:00.000Z");
    }),
  );

  /**
   * Only the run being stopped. A cake attached to several threads runs on all
   * of them, and a stop pressed in one thread's composer must not close the
   * runs the others are still executing.
   */
  it.effect("closes only the newest open run on the named thread", () =>
    Effect.gen(function* () {
      yield* migrate;
      const repo = yield* CakeRepository;

      yield* repo.upsert(sampleCake("cake-1"), NOW);
      yield* repo.recordRun({
        id: "run-old",
        cakeId: "cake-1",
        threadId: "thread-1",
        scheduledFor: "2026-01-01T09:00:00.000Z",
        startedAt: "2026-01-01T09:00:01.000Z",
        outcome: "started",
        detail: null,
      });
      yield* repo.recordRun({
        id: "run-new",
        cakeId: "cake-1",
        threadId: "thread-1",
        scheduledFor: "2026-01-02T09:00:00.000Z",
        startedAt: "2026-01-02T09:00:01.000Z",
        outcome: "started",
        detail: null,
      });
      yield* repo.recordRun({
        id: "run-other-thread",
        cakeId: "cake-1",
        threadId: "thread-2",
        scheduledFor: "2026-01-02T09:00:00.000Z",
        startedAt: "2026-01-02T09:00:01.000Z",
        outcome: "started",
        detail: null,
      });

      yield* repo.markRunStopped({
        cakeId: "cake-1",
        threadId: "thread-1",
        stoppedAt: "2026-01-02T09:30:00.000Z",
      });

      const outcomes = new Map(
        (yield* repo.listRuns("cake-1")).map((run) => [run.id, run.outcome] as const),
      );
      assert.deepEqual(
        [outcomes.get("run-old"), outcomes.get("run-new"), outcomes.get("run-other-thread")],
        ["started", "stopped", "started"],
      );
    }),
  );

  /**
   * Pressing stop on a thread whose run already ended is an ordinary race, not
   * an error: the scheduled run can finish between the button appearing and the
   * click landing. It must not reopen or rewrite anything.
   */
  it.effect("records nothing when the cake has no open run", () =>
    Effect.gen(function* () {
      yield* migrate;
      const repo = yield* CakeRepository;

      yield* repo.upsert(sampleCake("cake-1"), NOW);
      yield* repo.recordRun({
        id: "run-1",
        cakeId: "cake-1",
        threadId: "thread-1",
        scheduledFor: "2026-01-01T09:00:00.000Z",
        startedAt: null,
        outcome: "missed",
        detail: "server was not running",
      });

      yield* repo.markRunStopped({
        cakeId: "cake-1",
        threadId: "thread-1",
        stoppedAt: "2026-01-01T09:30:00.000Z",
      });

      const runs = yield* repo.listRuns("cake-1");
      assert.equal(runs[0]?.outcome, "missed");
      assert.equal(runs[0]?.detail, "server was not running");
    }),
  );

  /**
   * Deleting a cake must take its attachments with it. An orphaned attachment
   * is a schedule with no configuration behind it — the scheduler would either
   * fail on it every tick or skip it silently forever.
   */
  /**
   * The Stop Cake button has to light for a run the scheduler started, on a
   * client that knows nothing about it. Nothing on the wire marks a turn as a
   * cake's, so the join below is the only evidence that exists: the run wrote
   * down the message id its `thread.turn.start` carried, and the turn
   * projection keeps that message id beside the turn id the session reports as
   * active.
   */
  const seedRunningTurn = (input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly messageId: string;
    readonly activeTurnId: string | null;
  }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, assistant_message_id, state,
          requested_at, started_at, completed_at, checkpoint_turn_count,
          checkpoint_ref, checkpoint_status, checkpoint_files_json
        ) VALUES (
          ${input.threadId}, ${input.turnId}, ${input.messageId}, NULL, 'running',
          ${NOW}, ${NOW}, NULL, NULL, NULL, NULL, '[]'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, active_turn_id, last_error, updated_at
        ) VALUES (
          ${input.threadId}, 'running', 'claudeAgent', ${input.activeTurnId}, NULL, ${NOW}
        )
      `;
    });

  const clearTurnProjections = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM projection_turns`;
    yield* sql`DELETE FROM projection_thread_sessions`;
  });

  it.effect("keeps the turn a run started, so the run can be recognised later", () =>
    Effect.gen(function* () {
      yield* migrate;
      const repo = yield* CakeRepository;

      yield* repo.upsert(sampleCake("cake-1"), NOW);
      yield* repo.recordRun({
        id: "run-1",
        cakeId: "cake-1",
        threadId: "thread-1",
        scheduledFor: "2026-01-01T09:00:00.000Z",
        startedAt: "2026-01-01T09:00:01.000Z",
        outcome: "started",
        detail: null,
        turnMessageId: "message-1",
      });

      const runs = yield* repo.listRuns("cake-1");
      assert.equal(runs[0]?.turnMessageId, "message-1");
    }),
  );

  it.effect("names the cake whose run owns the thread's active turn", () =>
    Effect.gen(function* () {
      yield* migrate;
      yield* clearTurnProjections;
      const repo = yield* CakeRepository;

      yield* repo.upsert(sampleCake("cake-1"), NOW);
      yield* repo.recordRun({
        id: "run-1",
        cakeId: "cake-1",
        threadId: "thread-1",
        scheduledFor: "2026-01-01T09:00:00.000Z",
        startedAt: "2026-01-01T09:00:01.000Z",
        outcome: "started",
        detail: null,
        turnMessageId: "message-1",
      });
      yield* seedRunningTurn({
        threadId: "thread-1",
        turnId: "turn-1",
        messageId: "message-1",
        activeTurnId: "turn-1",
      });

      assert.equal(yield* repo.activeCakeIdForThread("thread-1"), "cake-1");
    }),
  );

  /**
   * The user typing into a thread a cake also runs on is the case that must not
   * light the button: their turn is active, the cake's run is over, and
   * offering to stop "the cake" would stop the person's own work.
   */
  it.effect("names nothing when the active turn is not the cake's", () =>
    Effect.gen(function* () {
      yield* migrate;
      yield* clearTurnProjections;
      const repo = yield* CakeRepository;

      yield* repo.upsert(sampleCake("cake-1"), NOW);
      yield* repo.recordRun({
        id: "run-1",
        cakeId: "cake-1",
        threadId: "thread-1",
        scheduledFor: "2026-01-01T09:00:00.000Z",
        startedAt: "2026-01-01T09:00:01.000Z",
        outcome: "started",
        detail: null,
        turnMessageId: "message-1",
      });
      yield* seedRunningTurn({
        threadId: "thread-1",
        turnId: "turn-1",
        messageId: "message-1",
        activeTurnId: "turn-2",
      });

      assert.equal(yield* repo.activeCakeIdForThread("thread-1"), null);
    }),
  );

  /**
   * A missed slot records a run with no turn behind it. Matching on a null
   * message id would make every thread with a missed run look busy with a cake.
   */
  it.effect("names nothing for a run that never started a turn", () =>
    Effect.gen(function* () {
      yield* migrate;
      yield* clearTurnProjections;
      const repo = yield* CakeRepository;

      yield* repo.upsert(sampleCake("cake-1"), NOW);
      yield* repo.recordRun({
        id: "run-1",
        cakeId: "cake-1",
        threadId: "thread-1",
        scheduledFor: "2026-01-01T09:00:00.000Z",
        startedAt: null,
        outcome: "missed",
        detail: "the slot passed while the scheduler was not running",
        turnMessageId: null,
      });
      yield* seedRunningTurn({
        threadId: "thread-1",
        turnId: "turn-1",
        messageId: "message-1",
        activeTurnId: "turn-1",
      });

      assert.equal(yield* repo.activeCakeIdForThread("thread-1"), null);
    }),
  );

  it.effect("deleting a cake removes its attachments", () =>
    Effect.gen(function* () {
      yield* migrate;
      const repo = yield* CakeRepository;

      yield* repo.upsert(sampleCake("cake-1"), NOW);
      yield* repo.attach({ cakeId: "cake-1", threadId: "thread-1", nextRunAt: NOW }, NOW);
      yield* repo.remove("cake-1");

      assert.isTrue(Option.isNone(yield* repo.getById("cake-1")));
      assert.equal((yield* repo.listAttachmentsForThread("thread-1")).length, 0);
    }),
  );
});
