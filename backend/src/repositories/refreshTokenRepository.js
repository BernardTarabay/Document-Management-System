const db = require("../config/database");

async function create({ userId, tokenHash, expiresAt, ipAddress, userAgent }) {
  const { rows } = await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [userId, tokenHash, expiresAt, ipAddress, userAgent]
  );
  return rows[0];
}

async function findValidByHash(tokenHash) {
  const { rows } = await db.query(
    `SELECT * FROM refresh_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [tokenHash]
  );
  return rows[0] || null;
}

async function revoke(id, replacedByTokenId = null) {
  await db.query(
    "UPDATE refresh_tokens SET revoked_at = now(), replaced_by_token_id = $2 WHERE id = $1",
    [id, replacedByTokenId]
  );
}

/**
 * Atomically take a valid refresh token out of circulation, returning the row
 * only to the caller that actually won it.
 *
 * This replaces a findValidByHash-then-revoke pair, which was a read-modify-
 * write across two statements: two requests presenting the same token could
 * both see it valid and both be issued a fresh session, so one refresh token
 * quietly became two live chains. It also meant a replayed token was
 * indistinguishable from a legitimate one -- there was nothing anywhere that
 * could notice a stolen token being used, because using it never conflicted
 * with anything.
 *
 * A single UPDATE ... WHERE revoked_at IS NULL RETURNING makes the revocation
 * the claim. Exactly one caller gets a row back; anyone else presenting the
 * same value gets nothing, which is the signal that it was already spent.
 */
async function claimValidByHash(tokenHash) {
  const { rows } = await db.query(
    `UPDATE refresh_tokens
        SET revoked_at = now()
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > now()
      RETURNING *`,
    [tokenHash]
  );
  return rows[0] || null;
}

/** Was this token real, but already spent or expired? Distinguishes a replay
 *  from a value that was never issued at all. */
async function findAnyByHash(tokenHash) {
  const { rows } = await db.query("SELECT * FROM refresh_tokens WHERE token_hash = $1", [tokenHash]);
  return rows[0] || null;
}

async function setReplacedBy(id, replacedByTokenId) {
  await db.query(
    "UPDATE refresh_tokens SET replaced_by_token_id = $2 WHERE id = $1",
    [id, replacedByTokenId]
  );
}

/**
 * Drop tokens that can no longer authenticate anyone. Called on login (a
 * naturally rare event) rather than on a timer, so there is no scheduler to
 * own and no work done on the hot refresh path -- see migration 026 for why
 * this table needed pruning at all.
 */
async function pruneExpired() {
  const { rowCount } = await db.query(
    `DELETE FROM refresh_tokens
      WHERE expires_at < now() - interval '30 days'
         OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')`
  );
  return rowCount;
}

async function revokeAllForUser(userId) {
  await db.query(
    "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
    [userId]
  );
}

module.exports = {
  create, findValidByHash, revoke, revokeAllForUser,
  claimValidByHash, findAnyByHash, setReplacedBy, pruneExpired,
};
