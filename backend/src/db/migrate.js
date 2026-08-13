#!/usr/bin/env node
// Forward-only SQL migration runner.
// Applies backend/migrations/*.sql in lexical order, tracks applied files in
// schema_migrations, and wraps each migration in its own transaction so a
// failure never leaves a migration half-applied.
const fs = require("fs");
const path = require("path");
const { pool } = require("../config/database");

const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "migrations");

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function getAppliedMigrations(client) {
  const { rows } = await client.query("SELECT filename FROM schema_migrations");
  return new Set(rows.map((r) => r.filename));
}

async function run() {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrations(client);

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let appliedCount = 0;
    for (const file of files) {
      if (applied.has(file)) continue;

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      console.log(`[migrate] Applying ${file} ...`);
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file]
        );
        await client.query("COMMIT");
        appliedCount += 1;
        console.log(`[migrate] Applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`[migrate] Failed on ${file}:`, err.message);
        throw err;
      }
    }

    if (appliedCount === 0) {
      console.log("[migrate] Nothing to apply, schema is up to date.");
    } else {
      console.log(`[migrate] Applied ${appliedCount} migration(s).`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error("[migrate] Migration run failed:", err);
  process.exitCode = 1;
});
