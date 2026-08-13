const db = require("../config/database");

async function create({ storageLocationId, jobId = null }) {
  const { rows } = await db.query(
    `INSERT INTO filesystem_scans (storage_location_id, job_id, status, started_at)
     VALUES ($1, $2, 'running', now()) RETURNING *`,
    [storageLocationId, jobId]
  );
  return rows[0];
}

async function complete(id, counts) {
  const { rows } = await db.query(
    `UPDATE filesystem_scans SET
       status = 'completed',
       files_discovered = $2, files_new = $3, files_missing = $4,
       files_moved = $5, files_changed = $6, files_recovered = $7,
       finished_at = now()
     WHERE id = $1 RETURNING *`,
    [
      id,
      counts.discovered || 0,
      counts.new || 0,
      counts.missing || 0,
      counts.moved || 0,
      counts.changed || 0,
      counts.recovered || 0,
    ]
  );
  return rows[0] || null;
}

async function fail(id) {
  await db.query("UPDATE filesystem_scans SET status = 'failed', finished_at = now() WHERE id = $1", [id]);
}

/**
 * One query, most-recent scan per location (DISTINCT ON + matching ORDER BY
 * -- Postgres' idiom for "latest row per group"). Used to show "last
 * scanned" on the Storage Locations page without an N+1 query per card.
 */
async function findLatestForLocations(storageLocationIds) {
  if (!storageLocationIds || storageLocationIds.length === 0) return {};
  const { rows } = await db.query(
    `SELECT DISTINCT ON (storage_location_id) *
     FROM filesystem_scans
     WHERE storage_location_id = ANY($1::uuid[])
     ORDER BY storage_location_id, started_at DESC NULLS LAST, created_at DESC`,
    [storageLocationIds]
  );
  return Object.fromEntries(rows.map((r) => [r.storage_location_id, r]));
}

module.exports = { create, complete, fail, findLatestForLocations };
