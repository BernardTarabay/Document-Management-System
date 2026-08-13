const db = require("../config/database");

async function create({ jobId, fileId, status = "pending" }) {
  const { rows } = await db.query(
    `INSERT INTO processing_job_items (job_id, file_id, status)
     VALUES ($1,$2,$3)
     ON CONFLICT (job_id, file_id) DO UPDATE SET status = EXCLUDED.status
     RETURNING *`,
    [jobId, fileId, status]
  );
  return rows[0];
}

async function complete(id, { status, errorMessage = null, result = null }) {
  const { rows } = await db.query(
    `UPDATE processing_job_items SET status = $2, error_message = $3, result = $4, processed_at = now()
     WHERE id = $1 RETURNING *`,
    [id, status, errorMessage, result]
  );
  return rows[0] || null;
}

async function summaryForJob(jobId) {
  const { rows } = await db.query(
    `SELECT status, COUNT(*)::int AS count FROM processing_job_items
     WHERE job_id = $1 GROUP BY status`,
    [jobId]
  );
  return rows;
}

async function listForJob(jobId, { limit = 100, offset = 0 } = {}) {
  const { rows } = await db.query(
    "SELECT * FROM processing_job_items WHERE job_id = $1 ORDER BY processed_at NULLS LAST LIMIT $2 OFFSET $3",
    [jobId, limit, offset]
  );
  return rows;
}

module.exports = { create, complete, summaryForJob, listForJob };
