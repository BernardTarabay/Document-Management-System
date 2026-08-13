// Small factory for the common shape every repository needs (find by id,
// paginated list, delete-by-id). Domain-specific queries live in each
// repository file, not here -- this only removes boilerplate.
const db = require("../config/database");

/**
 * @param {string} tableName
 * @param {object} [opts]
 * @param {string} [opts.defaultOrderBy]
 */
function createBaseRepository(tableName, opts = {}) {
  const orderBy = opts.defaultOrderBy || "created_at DESC";

  return {
    async findById(id) {
      const { rows } = await db.query(`SELECT * FROM ${tableName} WHERE id = $1`, [id]);
      return rows[0] || null;
    },

    async list({ limit = 50, offset = 0 } = {}) {
      const { rows } = await db.query(
        `SELECT * FROM ${tableName} ORDER BY ${orderBy} LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      return rows;
    },

    async count() {
      const { rows } = await db.query(`SELECT COUNT(*)::int AS count FROM ${tableName}`);
      return rows[0].count;
    },

    async deleteById(id) {
      await db.query(`DELETE FROM ${tableName} WHERE id = $1`, [id]);
    },
  };
}

module.exports = { createBaseRepository };
