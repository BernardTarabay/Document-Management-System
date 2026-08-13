// Background job tracking (spec §18/§22). Jobs are always rows, never bare
// in-memory tasks, so the frontend can poll/observe status regardless of
// which worker process picked the job up.
const db = require("../config/database");
const { createBaseRepository } = require("./baseRepository");

const base = createBaseRepository("processing_jobs");

async function create({ jobType, storageLocationId = null, payload = {}, createdBy = null, progressTotal = 0 }) {
  const { rows } = await db.query(
    `INSERT INTO processing_jobs (job_type, storage_location_id, payload, created_by, progress_total)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [jobType, storageLocationId, payload, createdBy, progressTotal]
  );
  return rows[0];
}

async function attachBullMqId(id, bullmqJobId) {
  await db.query("UPDATE processing_jobs SET bullmq_job_id = $2 WHERE id = $1", [id, bullmqJobId]);
}

async function markStarted(id) {
  const { rows } = await db.query(
    "UPDATE processing_jobs SET status = 'running', started_at = now() WHERE id = $1 RETURNING *",
    [id]
  );
  return rows[0] || null;
}

async function updateProgress(id, progressCurrent) {
  await db.query("UPDATE processing_jobs SET progress_current = $2 WHERE id = $1", [id, progressCurrent]);
}

/**
 * Set the denominator after the fact, for jobs that can only count their own
 * work once they start (reindex has to resolve which files it covers before
 * it knows the total; enqueueJob's `progressTotal` option is set at enqueue
 * time, which is too early for that).
 */
async function updateProgressTotal(id, progressTotal) {
  await db.query("UPDATE processing_jobs SET progress_total = $2 WHERE id = $1", [id, progressTotal]);
}

async function markCompleted(id, result = null) {
  const { rows } = await db.query(
    `UPDATE processing_jobs SET status = 'completed', result = $2, finished_at = now() WHERE id = $1 RETURNING *`,
    [id, result]
  );
  return rows[0] || null;
}

async function markFailed(id, errorMessage) {
  const { rows } = await db.query(
    `UPDATE processing_jobs SET status = 'failed', error_message = $2, finished_at = now() WHERE id = $1 RETURNING *`,
    [id, errorMessage]
  );
  return rows[0] || null;
}

async function markCancelled(id) {
  const { rows } = await db.query(
    `UPDATE processing_jobs SET status = 'cancelled', finished_at = now() WHERE id = $1 RETURNING *`,
    [id]
  );
  return rows[0] || null;
}

async function listActive({ limit = 50, offset = 0 } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM processing_jobs WHERE status IN ('queued','running','retrying')
     ORDER BY created_at ASC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

module.exports = {
  ...base, create, attachBullMqId, markStarted, updateProgress, updateProgressTotal,
  markCompleted, markFailed, markCancelled, listActive,
};
