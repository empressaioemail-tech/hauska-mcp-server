// Idempotent SQL migration runner.
//
// Applies every *.sql file in ./migrations/ that has not already been
// recorded in the schema_migrations table. Files run in lexicographic
// order. Each migration runs in its own transaction.
//
// Usage:
//   DATABASE_URL=postgres://... npm run migrate

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const { Pool } = pg;

const MIGRATIONS_DIR = resolve(
  fileURLToPath(new URL("../migrations/", import.meta.url)),
);

async function ensureMigrationsTable(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function appliedSet(pool: pg.Pool): Promise<Set<string>> {
  const result = await pool.query<{ filename: string }>(
    "SELECT filename FROM schema_migrations",
  );
  return new Set(result.rows.map((r) => r.filename));
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const pool = new Pool({ connectionString });

  try {
    await ensureMigrationsTable(pool);
    const applied = await appliedSet(pool);
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let appliedThisRun = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.error(`[skip] ${file}`);
        continue;
      }
      const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
      console.error(`[apply] ${file}`);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
        appliedThisRun += 1;
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`[fail] ${file}:`, err);
        throw err;
      } finally {
        client.release();
      }
    }
    console.error(`Migration complete. Applied ${appliedThisRun} new file(s).`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
