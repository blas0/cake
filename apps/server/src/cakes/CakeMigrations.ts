import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";

import Migration0001 from "./migrations/001_Cakes.ts";

/**
 * The cake feature's migrations, tracked apart from upstream's.
 *
 * Upstream keys migrations by a single numeric sequence and records the highest
 * applied id in `effect_sql_migrations`. The migrator then runs everything
 * above that id and nothing below it:
 *
 *   if (currentId <= latestMigrationId) continue;
 *
 * The cake migrations used to sit in that same sequence at 41–44. Then upstream
 * shipped its own 41 — `AuthSessionClientConnection` — and the consequence was
 * not a conflict but a silence: a database that had run `41_Cakes` recorded 44
 * as its latest, so upstream's 41 was skipped, and so would every upstream
 * migration numbered 42, 43 or 44 that followed. `auth_sessions` simply never
 * gained its new column, and nothing said so. A fresh install fared no better:
 * two entries claiming id 41, and a refusal to boot.
 *
 * Renumbering the cake band higher would have made it worse — a latest of 903
 * hides upstream for years. The only structure the migrator's rule permits is
 * two sequences that never read each other's latest. So cakes get their own
 * table, `effect_sql_migrations_cakes`, and their own runner. Upstream's
 * sequence is exactly what it would be without this fork, which is also what
 * keeps the merge surface small: this fork no longer touches `Migrations.ts`.
 *
 * The one migration here is `IF NOT EXISTS` throughout, so it is a no-op on a
 * database that already has the shape. That is what makes the transition from
 * the old band safe without remapping any ids: the stale 41–44 rows in
 * upstream's table are deleted, this table starts empty, this migration runs
 * and finds everything already there. The deletion is the one write to an
 * existing database this change requires, and it is a separate, read-before-run
 * script rather than something this layer does on its own.
 */
const cakeMigrationEntries = [[1, "Cakes", Migration0001]] as const;

export const CAKE_MIGRATIONS_TABLE = "effect_sql_migrations_cakes";

export const cakeMigrationManifest = cakeMigrationEntries.map(([id, name]) => [id, name] as const);

const loader = Migrator.fromRecord(
  Object.fromEntries(
    cakeMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
  ),
);

const run = Migrator.make({});

export const runCakeMigrations = Effect.fn("runCakeMigrations")(function* () {
  // `table` belongs to the run call, not to `make`. Passed to `make` it is
  // accepted and ignored — both runners then read `effect_sql_migrations`,
  // upstream's latest is 40, this migration is id 1, and `1 <= 40` skips it
  // in silence. Exactly the failure this file exists to prevent, one layer
  // down. The test that proved it is "track themselves in their own table".
  const executed = yield* run({ loader, table: CAKE_MIGRATIONS_TABLE });
  const migrations = executed.map(([id, name]) => `cakes/${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Cake schema is current")
    : Effect.log("Cake migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executed;
});

/**
 * Built after `MigrationsLive`, never instead of it. The cake tables reference
 * nothing upstream owns, but the ordering keeps one rule simple: upstream's
 * schema is settled before the fork adds to it.
 */
export const CakeMigrationsLive = Layer.effectDiscard(runCakeMigrations());
