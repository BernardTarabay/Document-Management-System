const db = require("../config/database");
const { createBaseRepository } = require("./baseRepository");

const base = createBaseRepository("users");

async function findByEmail(email) {
  const { rows } = await db.query("SELECT * FROM users WHERE email = $1", [email]);
  return rows[0] || null;
}

async function create({ email, passwordHash, fullName, status = "active" }) {
  const { rows } = await db.query(
    `INSERT INTO users (email, password_hash, full_name, status)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [email, passwordHash, fullName, status]
  );
  return rows[0];
}

async function updateLastLogin(id) {
  await db.query("UPDATE users SET last_login_at = now() WHERE id = $1", [id]);
}

async function getRolesForUser(userId) {
  const { rows } = await db.query(
    `SELECT r.* FROM roles r
     JOIN user_roles ur ON ur.role_id = r.id
     WHERE ur.user_id = $1`,
    [userId]
  );
  return rows;
}

async function getPermissionsForUser(userId) {
  const { rows } = await db.query(
    `SELECT DISTINCT p.key FROM permissions p
     JOIN role_permissions rp ON rp.permission_id = p.id
     JOIN user_roles ur ON ur.role_id = rp.role_id
     WHERE ur.user_id = $1`,
    [userId]
  );
  return rows.map((r) => r.key);
}

async function assignRole(userId, roleId, grantedBy) {
  await db.query(
    `INSERT INTO user_roles (user_id, role_id, granted_by)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [userId, roleId, grantedBy]
  );
}

/**
 * Make `roleId` the user's ONLY role, in one transaction.
 *
 * The Users page presents a single role per user, so "change role" has to
 * remove the old one as well as add the new one -- assignRole alone would
 * accumulate roles and a "demoted" admin would quietly keep every admin
 * permission through their old grant. Wrapped in a transaction so a failure
 * can never leave the user with no role at all.
 */
async function setSoleRole(userId, roleId, grantedBy) {
  return db.withTransaction(async (client) => {
    await client.query("DELETE FROM user_roles WHERE user_id = $1 AND role_id <> $2", [userId, roleId]);
    await client.query(
      `INSERT INTO user_roles (user_id, role_id, granted_by)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [userId, roleId, grantedBy]
    );
  });
}

async function setStatus(id, status) {
  const { rows } = await db.query(
    "UPDATE users SET status = $2, updated_at = now() WHERE id = $1 RETURNING *",
    [id, status]
  );
  return rows[0] || null;
}

async function setPasswordHash(id, passwordHash) {
  const { rows } = await db.query(
    "UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1 RETURNING *",
    [id, passwordHash]
  );
  return rows[0] || null;
}

/**
 * Users with their roles in one query. The Users page needs a role per row;
 * fetching them per user turned rendering the page into an N+1.
 */
async function listWithRoles({ limit = 50, offset = 0 } = {}) {
  const { rows } = await db.query(
    `SELECT u.*,
            COALESCE(
              json_agg(json_build_object('id', r.id, 'name', r.name))
                FILTER (WHERE r.id IS NOT NULL),
              '[]'
            ) AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     GROUP BY u.id
     ORDER BY u.created_at ASC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

/**
 * How many ACTIVE users still hold a given role. Used to refuse the last
 * admin being demoted or suspended -- an app with no reachable admin can
 * only be recovered with raw SQL against the database.
 */
async function countActiveUsersWithRole(roleName, excludeUserId = null) {
  const { rows } = await db.query(
    `SELECT count(DISTINCT u.id)::int AS count
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE r.name = $1 AND u.status = 'active'
       AND ($2::uuid IS NULL OR u.id <> $2)`,
    [roleName, excludeUserId]
  );
  return rows[0].count;
}

module.exports = {
  ...base,
  findByEmail,
  create,
  updateLastLogin,
  getRolesForUser,
  getPermissionsForUser,
  assignRole,
  setSoleRole,
  setStatus,
  setPasswordHash,
  listWithRoles,
  countActiveUsersWithRole,
};
