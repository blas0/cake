import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as SqlError from "effect/unstable/sql/SqlError";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { CAKE_MIGRATIONS_TABLE, runCakeMigrations } from "./CakeMigrations.ts";

/**
 * The cake schema, tracked apart from upstream's.
 *
 * The cake migrations used to share upstream's numeric sequence at 41–44, and
 * the day upstream shipped its own 41 the migrator's one rule — run everything
 * above the highest applied id — meant a database that had run the cake band
 * skipped upstream's migration in silence. Every assertion here is about the
 * two sequences staying out of each other's way, and about the transition off
 * the old band costing an existing database nothing.
 *
 * A database per case, because a migration runs exactly once against a given
 * one and a shared instance would leave later cases asserting against tables
 * an earlier case had already built.
 */
const onFreshDatabase = <A, E>(
  effect: Effect.Effect<A, E, SqlClient.SqlClient>,
): Effect.Effect<A, E | SqlError.SqlError> =>
  Effect.provide(effect, NodeSqliteClient.layerMemory());

interface ColumnRow {
  readonly name: string;
}
interface IdRow {
  readonly migration_id: number;
}

const columnsOf = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      yield* sql<ColumnRow>`SELECT name FROM pragma_table_info(${sql.literal(`'${table}'`)})`;
    return rows.map((row) => row.name).sort();
  });

const idsIn = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<IdRow>`SELECT migration_id FROM ${sql(table)} ORDER BY migration_id`;
    return rows.map((row) => row.migration_id);
  });

/** The shape the live database has today, column for column. */
const FINAL_CAKES_COLUMNS = [
  "anchor_cadence",
  "anchor_hour",
  "anchor_meridiem",
  "anchor_time_zone",
  "created_at",
  "disallowed_tools",
  "effort",
  "id",
  "instructions",
  "interval_count",
  "interval_unit",
  "model",
  "name",
  "provider_kind",
  "schedule_kind",
  "updated_at",
];

describe("cake migrations", () => {
  it.effect("create the final schema on a fresh database", () =>
    onFreshDatabase(
      Effect.gen(function* () {
        yield* runMigrations();
        yield* runCakeMigrations();

        assert.deepStrictEqual(yield* columnsOf("cakes"), FINAL_CAKES_COLUMNS);
        assert.deepStrictEqual(yield* columnsOf("cake_runs"), [
          "cake_id",
          "detail",
          "id",
          "outcome",
          "scheduled_for",
          "started_at",
          "thread_id",
          "turn_message_id",
        ]);
      }),
    ),
  );

  /**
   * The transition off the old band. A database that ran 041–044 already has
   * this exact shape, and the only thing wrong with it is four stale rows in
   * upstream's tracking table. Those rows are deleted by a separate script;
   * this is what proves that once they are gone, running the collapsed
   * migration against the already-shaped tables changes nothing and loses
   * nothing.
   */
  it.effect("are a no-op on a database that already has the shape, and keep its rows", () =>
    onFreshDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* runCakeMigrations();
        yield* sql`
          INSERT INTO cakes (id, name, provider_kind, model, effort, disallowed_tools, instructions,
            created_at, updated_at, schedule_kind, interval_count, interval_unit)
          VALUES ('cake_1', 'Nightly', 'claudeAgent', 'claude-opus-5', 'high', '[]', 'Do it.',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'every', 2, 'hour')
        `;

        // Simulate a second boot: the tracking row exists, the tables exist.
        yield* runCakeMigrations();

        const rows = yield* sql<{ readonly id: string }>`SELECT id FROM cakes`;
        assert.deepStrictEqual(
          rows.map((row) => row.id),
          ["cake_1"],
        );
        assert.deepStrictEqual(yield* columnsOf("cakes"), FINAL_CAKES_COLUMNS);
      }),
    ),
  );

  it.effect("track themselves in their own table, not upstream's", () =>
    onFreshDatabase(
      Effect.gen(function* () {
        yield* runMigrations();
        yield* runCakeMigrations();

        const upstream = yield* idsIn("effect_sql_migrations");
        const cakes = yield* idsIn(CAKE_MIGRATIONS_TABLE);

        assert.deepStrictEqual(cakes, [1]);
        // The cake band is gone from upstream's sequence entirely — nothing
        // above 41 that this fork put there.
        assert.ok(!upstream.includes(42) && !upstream.includes(43) && !upstream.includes(44));
      }),
    ),
  );

  /**
   * The property the old design violated. Upstream's latest is whatever
   * upstream's latest is; the cake table's latest cannot shadow it.
   */
  it.effect("leave upstream's latest id where upstream put it", () =>
    onFreshDatabase(
      Effect.gen(function* () {
        yield* runMigrations();
        const before = yield* idsIn("effect_sql_migrations");
        yield* runCakeMigrations();
        const after = yield* idsIn("effect_sql_migrations");

        assert.deepStrictEqual(after, before);
      }),
    ),
  );
});
