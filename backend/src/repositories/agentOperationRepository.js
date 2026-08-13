// The backend <-> Filesystem Agent operation channel
// (docs/04-storage-architecture.md §4.5, migration 017).
const db = require("../config/database");
const { createBaseRepository } = require("./baseRepository");

const base = createBaseRepository("agent_operations");

async function create({ agentId, operationType, payload, expiresInSeconds = 300 }) {
  const { rows } = await db.query(
    `INSERT INTO agent_operations (agent_id, operation_type, payload, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))
     RETURNING *`,
    [agentId, operationType, payload, expiresInSeconds]
  );
  return rows[0];
}

/**
 * Atomically hand the agent its next pending operations.
 *
 * The UPDATE...FROM (SELECT ... FOR UPDATE SKIP LOCKED) shape matters: an
 * agent may legitimately have several instances or a retrying poll in
 * flight, and without SKIP LOCKED two concurrent polls would block on each
 * other and could hand the SAME operation to both -- meaning a rename could
 * be executed twice. This claims each row exactly once.
 */
async function claimNext(agentId, limit = 10) {
  const { rows } = await db.query(
    `UPDATE agent_operations op
     SET status = 'dispatched', dispatched_at = now()
     FROM (
       SELECT id FROM agent_operations
       WHERE agent_id = $1 AND status = 'pending' AND expires_at > now()
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT $2
     ) claimed
     WHERE op.id = claimed.id
     RETURNING op.*`,
    [agentId, limit]
  );
  return rows;
}

async function complete(id, agentId, { status, result = null, errorMessage = null }) {
  const { rows } = await db.query(
    `UPDATE agent_operations
     SET status = $3, result = $4, error_message = $5, completed_at = now()
     WHERE id = $1 AND agent_id = $2 AND status = 'dispatched'
     RETURNING *`,
    [id, agentId, status, result, errorMessage]
  );
  return rows[0] || null;
}

async function findById(id) {
  const { rows } = await db.query("SELECT * FROM agent_operations WHERE id = $1", [id]);
  return rows[0] || null;
}

/**
 * Mark operations past their deadline as expired. Covers the agent going
 * offline mid-operation: without this, a caller waiting on a claimed
 * operation would wait forever and the row would sit 'dispatched' for good.
 */
async function expireOverdue() {
  const { rows } = await db.query(
    `UPDATE agent_operations
     SET status = 'expired', completed_at = now(),
         error_message = 'The agent did not report a result before the operation expired.'
     WHERE status IN ('pending', 'dispatched') AND expires_at <= now()
     RETURNING id, agent_id`
  );
  return rows;
}

async function listForAgent(agentId, { limit = 50, offset = 0 } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM agent_operations WHERE agent_id = $1
     ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [agentId, limit, offset]
  );
  return rows;
}

module.exports = { ...base, create, claimNext, complete, findById, expireOverdue, listForAgent };
