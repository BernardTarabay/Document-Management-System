#!/usr/bin/env node
// Wipes everything that accumulates from scanning/uploading/processing
// files, for starting a clean test run without losing login access or
// taxonomy setup. Deliberately does NOT touch: users, roles, permissions,
// user_roles (you'd be locked out), subjects/document_types/tags (the seed
// taxonomy the naming pipeline depends on), refresh_tokens (no need to
// force a re-login), schema_migrations, or filesystem_agents (unrelated,
// unimplemented Phase 12 feature).
//
// Also deletes the physical bytes under the managed upload location's
// root (UPLOAD_ROOT) -- truncating the `files`/`storage_locations` rows
// alone would leave the actual uploaded copies orphaned on disk, and the
// next managed upload re-provisions a location pointing at the exact same
// folder, so leftover bytes there would just get rescanned right back in.
//
// Usage: npm run db:reset-data   (run from backend/, with the API and
// worker processes stopped first so nothing writes mid-reset)
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const readline = require("readline");
const { pool } = require("../config/database");
const env = require("../config/env");
const { getQueue, closeAllQueues } = require("../queues");
const { closeRedisConnection } = require("../config/redis");
const { JobType } = require("../models/enums");

const TABLES_TO_WIPE = [
  "processing_job_items",
  "processing_jobs",
  "duplicate_group_members",
  "duplicate_groups",
  "rename_proposals",
  "classification_results",
  "file_hashes",
  "file_content",
  "file_metadata",
  "related_documents",
  "document_versions",
  "document_subjects",
  "document_tags",
  "documents",
  "files",
  "filesystem_scans",
  "audit_logs",
  "storage_locations",
];

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

async function run() {
  const force = process.argv.includes("--yes");
  if (!force) {
    const answer = await confirm(
      `This permanently deletes ALL files, documents, proposals, duplicate groups, processing\n` +
      `jobs, audit log entries, and storage locations (users/roles/taxonomy are kept).\n` +
      `It also deletes uploaded file bytes under: ${path.resolve(process.env.UPLOAD_ROOT || "./storage/uploads")}\n` +
      `Type "yes" to continue: `
    );
    if (answer.trim().toLowerCase() !== "yes") {
      console.log("[reset-data] Aborted.");
      return;
    }
  }

  // QUEUES FIRST, THEN TABLES.
  //
  // processing_jobs is only half the story: the work itself lives in Redis,
  // and truncating the table while BullMQ still holds tens of thousands of
  // jobs leaves the worker grinding through every one of them against rows
  // that no longer exist. On a real reset that was 15,759 queued jobs -- a
  // "clean slate" that spends the next hour logging failures and can even
  // re-insert rows behind the truncate.
  //
  // Draining first also stops new work arriving mid-reset. A job already
  // executing at this instant may still write a row afterwards, which is
  // exactly why the truncate comes second and mops those up.
  await drainQueues();

  const client = await pool.connect();
  try {
    console.log("[reset-data] Truncating tables...");
    await client.query("BEGIN");
    await client.query(`TRUNCATE TABLE ${TABLES_TO_WIPE.join(", ")} RESTART IDENTITY CASCADE`);
    await client.query("COMMIT");
    console.log(`[reset-data] Truncated: ${TABLES_TO_WIPE.join(", ")}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // SECOND SWEEP.
  //
  // The header says to stop the worker first, and on a real reset nobody
  // did -- jobs that were already executing when the truncate landed
  // finished afterwards and wrote a duplicate group, four processing_jobs
  // rows and seven audit entries referencing files that no longer exist.
  // Small, but the whole point of this script is that "0 files" means zero
  // of everything. The queues are already drained by now, so nothing new can
  // start; this just catches whatever was mid-flight.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const strays = await pool.query(
    `SELECT (SELECT count(*) FROM processing_jobs)
          + (SELECT count(*) FROM duplicate_groups)
          + (SELECT count(*) FROM audit_logs) AS n`
  );
  if (Number(strays.rows[0].n) > 0) {
    await pool.query(
      `TRUNCATE TABLE processing_job_items, processing_jobs, duplicate_group_members,
                     duplicate_groups, filesystem_scans, audit_logs RESTART IDENTITY CASCADE`
    );
    console.log(
      `[reset-data] Swept ${strays.rows[0].n} row(s) written by jobs that were still ` +
      "running when the truncate landed."
    );
  }

  const uploadRoot = path.resolve(process.env.UPLOAD_ROOT || "./storage/uploads");
  try {
    await fsp.rm(uploadRoot, { recursive: true, force: true });
    await fsp.mkdir(uploadRoot, { recursive: true });
    console.log(`[reset-data] Cleared uploaded file bytes at ${uploadRoot}`);
  } catch (err) {
    console.warn(`[reset-data] Could not clear ${uploadRoot}: ${err.message} (delete it by hand if needed)`);
  }

  await clearMirror();

  console.log("[reset-data] Done. Users, roles, and taxonomy (subjects/document types) were left untouched.");
  console.log("[reset-data] Your ORIGINAL files were not touched -- this app never moves or deletes them.");
}

/** Empty every BullMQ queue, including jobs already running. */
async function drainQueues() {
  let removed = 0;
  try {
    for (const jobType of Object.values(JobType)) {
      const queue = getQueue(jobType);
      const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed", "completed");
      removed += Object.values(counts).reduce((sum, n) => sum + n, 0);
      // force:true so jobs currently locked by a running worker go too --
      // without it obliterate refuses while anything is active, which is the
      // normal state on a machine where the worker is still up.
      await queue.obliterate({ force: true });
    }
    console.log(`[reset-data] Drained ${removed} queued/failed job(s) from Redis.`);
  } catch (err) {
    // A reset must still work with Redis down -- that is a common reason to
    // be resetting in the first place.
    console.warn(
      `[reset-data] Could not drain the Redis queues: ${err.message}\n` +
      "            If Redis comes back with old jobs in it, stop the worker and re-run this."
    );
  }
}

/**
 * Remove the organized shortcut mirror.
 *
 * The mirror is disposable by design -- it is regenerated from the database
 * by the sync_mirror job -- so leaving it behind after a wipe means a folder
 * full of shortcuts pointing at files the app no longer knows about.
 *
 * Only shortcut files are deleted, never anything else. The mirror lives in a
 * folder the user can open, and treating "delete the mirror" as "delete that
 * whole directory" would take anything they had dropped in there with it.
 */
async function clearMirror() {
  const mirrorRoot = env.mirrorRoot;
  if (!mirrorRoot) return;

  let removed = 0;
  let kept = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        // Only removes directories the walk left empty; rmdir on a
        // non-empty one throws and is ignored.
        await fsp.rmdir(full).catch(() => {});
      } else if (/\.(lnk|url)$/i.test(entry.name)) {
        await fsp.rm(full, { force: true }).catch(() => {});
        removed += 1;
      } else {
        kept += 1;
      }
    }
  }

  try {
    await walk(path.resolve(mirrorRoot));
    console.log(
      `[reset-data] Removed ${removed} shortcut(s) from the mirror at ${mirrorRoot}` +
      (kept > 0 ? ` (left ${kept} non-shortcut file(s) alone).` : ".")
    );
  } catch (err) {
    console.warn(`[reset-data] Could not clear the mirror at ${mirrorRoot}: ${err.message}`);
  }
}

run()
  .catch((err) => {
    console.error("[reset-data] Failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
    await closeAllQueues().catch(() => {});
    await closeRedisConnection().catch(() => {});
  });
