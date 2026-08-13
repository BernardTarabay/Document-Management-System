#!/usr/bin/env node
// One-off re-classification helper. Files scanned while the Gemini
// integration was broken (the `temperature` bug) never got a successful AI
// pass, so their existing rename_proposals rows are rule-based-only. This
// re-enqueues a `classify` job for those files, which (with
// AI_ESCALATE_BELOW_CONFIDENCE=always and a working GEMINI_API_KEY) now
// runs Gemini and produces a fresh classification_results +
// rename_proposals row. It does NOT delete the old proposal -- you'll see
// both in the Rename Proposals page afterward; reject the stale generic
// one, approve the new entity-enriched one.
//
// Usage (run from backend/, same env as the server/worker):
//   node src/db/reclassify.js --storage-location <storage-location-id>
//   node src/db/reclassify.js --file <file-id> [--file <file-id> ...]
const { pool } = require("../config/database");
const { enqueueJob, closeAllQueues } = require("../queues");
const { JobType } = require("../models/enums");

function parseArgs(argv) {
  const storageLocationIds = [];
  const fileIds = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--storage-location") storageLocationIds.push(argv[++i]);
    else if (argv[i] === "--file") fileIds.push(argv[++i]);
  }
  return { storageLocationIds, fileIds };
}

async function run() {
  const { storageLocationIds, fileIds } = parseArgs(process.argv.slice(2));
  if (!storageLocationIds.length && !fileIds.length) {
    console.error(
      "Usage: node src/db/reclassify.js --storage-location <id>  OR  --file <id> [--file <id> ...]"
    );
    process.exitCode = 1;
    return;
  }

  const client = await pool.connect();
  let targetIds = [...fileIds];
  try {
    for (const locId of storageLocationIds) {
      const { rows } = await client.query(
        `SELECT id FROM files WHERE storage_location_id = $1 AND status = 'active'`,
        [locId]
      );
      targetIds.push(...rows.map((r) => r.id));
    }

    targetIds = [...new Set(targetIds)];
    if (targetIds.length === 0) {
      console.log("[reclassify] No matching active files found.");
      return;
    }

    console.log(`[reclassify] Re-enqueuing classify for ${targetIds.length} file(s)...`);
    for (const fileId of targetIds) {
      await enqueueJob(JobType.CLASSIFY, { fileId }, {});
    }
    console.log("[reclassify] Done -- watch the worker logs or the Processing Jobs page.");
  } finally {
    client.release();
    await pool.end();
    await closeAllQueues();
  }
}

run().catch((err) => {
  console.error("[reclassify] Failed:", err);
  process.exitCode = 1;
});