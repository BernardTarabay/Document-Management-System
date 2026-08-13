// Shared helper for the verify-* scripts: take the fixture files back out of
// the queue before asserting anything about them.
//
// WHY THIS EXISTS
//
// A verify script sets a file up in a specific state -- never hashed, text
// unreadable, last job failed -- and then checks what the app says about it.
// But creating those fixtures goes through scanProcessor, which enqueues real
// HASH jobs into Redis. If a worker is running, it picks them up and processes
// the fixtures out from under the assertions: the "never hashed" file gets
// hashed, the "nothing is queued for it" file acquires a queued job, and the
// script fails describing a state that was true when it was written and is not
// true a second later.
//
// Deleting the `processing_jobs` rows (which the scripts already did) is only
// half of it -- the work itself lives in BullMQ, keyed by the same uuid. This
// removes both.
//
// It closes the window rather than sealing it: a job the worker has ALREADY
// started cannot be un-started. Running these scripts against an idle worker
// is still the reliable way, and this makes the common case work anyway.
const { getQueue } = require("../src/queues");
const { JobType } = require("../src/models/enums");

/**
 * Stop any running worker from taking new jobs while a script sets up its
 * fixtures.
 *
 * Removing the jobs after the fact is not enough on its own: a live worker
 * picks one up in the same millisecond scanProcessor enqueues it, so the
 * fixture is already being hashed before the script gets a chance to take it
 * back. Pausing is global in BullMQ -- it stops the separate worker process,
 * not just this one -- which is exactly what is needed here.
 *
 * Always paired with resumeQueues() from the script's cleanup, so a crash
 * still hands the queues back.
 */
async function pauseQueues() {
  for (const jobType of Object.values(JobType)) {
    await getQueue(jobType).pause().catch(() => {});
  }
}

async function resumeQueues() {
  for (const jobType of Object.values(JobType)) {
    await getQueue(jobType).resume().catch(() => {});
  }
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} storageLocationId - remove jobs for this location's files
 */
async function dequeueFixtureJobs(pool, storageLocationId) {
  const SCOPE = `
    storage_location_id = $1
    OR payload->>'fileId' IN (SELECT id::text FROM files WHERE storage_location_id = $1)
  `;

  const { rows } = await pool.query(
    `SELECT id, job_type FROM processing_jobs WHERE ${SCOPE}`,
    [storageLocationId]
  );

  for (const row of rows) {
    try {
      // enqueueJob reuses the processing_jobs uuid as the BullMQ job id, so
      // the row id is all that is needed to find it again.
      const job = await getQueue(row.job_type).getJob(row.id);
      if (job) await job.remove();
    } catch {
      // Already gone, already running, or Redis is down -- none of which
      // should stop the script from cleaning up the rows below.
    }
  }

  await pool.query(`DELETE FROM processing_jobs WHERE ${SCOPE}`, [storageLocationId]);
  return rows.length;
}

module.exports = { dequeueFixtureJobs, pauseQueues, resumeQueues };
