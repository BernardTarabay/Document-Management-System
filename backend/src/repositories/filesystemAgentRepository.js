const db = require("../config/database");
const { createBaseRepository } = require("./baseRepository");

const base = createBaseRepository("filesystem_agents");

async function findByStorageLocation(storageLocationId) {
  const { rows } = await db.query(
    "SELECT * FROM filesystem_agents WHERE storage_location_id = $1",
    [storageLocationId]
  );
  return rows;
}

/** The single active (non-revoked) agent brokering a location, if any. */
async function findActiveForStorageLocation(storageLocationId) {
  const { rows } = await db.query(
    `SELECT * FROM filesystem_agents
     WHERE storage_location_id = $1 AND revoked_at IS NULL
     ORDER BY last_seen_at DESC NULLS LAST, created_at ASC
     LIMIT 1`,
    [storageLocationId]
  );
  return rows[0] || null;
}

async function create({ storageLocationId, name, apiKeyHash, registeredDirectories = [] }) {
  const { rows } = await db.query(
    `INSERT INTO filesystem_agents
       (storage_location_id, name, api_key_hash, status, registered_directories)
     VALUES ($1, $2, $3, 'offline', $4)
     RETURNING *`,
    [storageLocationId, name, apiKeyHash, JSON.stringify(registeredDirectories)]
  );
  return rows[0];
}

/**
 * Enrollment/identity fields reported by the agent when it opens a session.
 * Written as one explicit statement rather than a generic column-name-driven
 * update: this table holds api_key_hash, and a dynamic updater is exactly
 * how a credential column ends up writable from a request body.
 */
async function updateEnrollment(id, { agentVersion, platform, hostname, registeredDirectories }) {
  const { rows } = await db.query(
    `UPDATE filesystem_agents SET
       enrolled_at   = COALESCE(enrolled_at, now()),
       agent_version = COALESCE($2, agent_version),
       platform      = COALESCE($3, platform),
       hostname      = COALESCE($4, hostname),
       registered_directories = COALESCE($5, registered_directories)
     WHERE id = $1
     RETURNING *`,
    [
      id,
      agentVersion || null,
      platform || null,
      hostname || null,
      registeredDirectories ? JSON.stringify(registeredDirectories) : null,
    ]
  );
  return rows[0] || null;
}

async function markHeartbeat(id) {
  const { rows } = await db.query(
    `UPDATE filesystem_agents SET status = 'online', last_seen_at = now()
     WHERE id = $1 RETURNING *`,
    [id]
  );
  return rows[0] || null;
}

async function markOffline(id) {
  await db.query("UPDATE filesystem_agents SET status = 'offline' WHERE id = $1", [id]);
}

async function revoke(id) {
  const { rows } = await db.query(
    `UPDATE filesystem_agents SET revoked_at = now(), status = 'offline'
     WHERE id = $1 RETURNING *`,
    [id]
  );
  return rows[0] || null;
}

/** Agents whose heartbeat has lapsed are marked offline so the UI and
 * AgentStorageService can fail fast instead of enqueuing work nobody will
 * ever claim. */
async function markStaleOffline(staleAfterSeconds = 120) {
  const { rows } = await db.query(
    `UPDATE filesystem_agents SET status = 'offline'
     WHERE status = 'online'
       AND (last_seen_at IS NULL OR last_seen_at < now() - make_interval(secs => $1))
     RETURNING id`,
    [staleAfterSeconds]
  );
  return rows;
}

module.exports = {
  ...base,
  findByStorageLocation,
  findActiveForStorageLocation,
  create,
  updateEnrollment,
  markHeartbeat,
  markOffline,
  revoke,
  markStaleOffline,
};
