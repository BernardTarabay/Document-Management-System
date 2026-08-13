#!/usr/bin/env node
// Loads reference/seed data (backend/seeds/*.sql). Seeds are idempotent
// (ON CONFLICT DO NOTHING) so this is safe to re-run at any time and is kept
// separate from schema migrations on purpose -- seeds are data, not schema.
const fs = require("fs");
const path = require("path");
const { pool } = require("../config/database");

const SEEDS_DIR = path.join(__dirname, "..", "..", "seeds");

async function run() {
  const client = await pool.connect();
  try {
    const files = fs
      .readdirSync(SEEDS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const sql = fs.readFileSync(path.join(SEEDS_DIR, file), "utf8");
      console.log(`[seed] Running ${file} ...`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("COMMIT");
        console.log(`[seed] Done ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`[seed] Failed on ${file}:`, err.message);
        throw err;
      }
    }
    console.log("[seed] All seeds applied.");
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error("[seed] Seed run failed:", err);
  process.exitCode = 1;
});
