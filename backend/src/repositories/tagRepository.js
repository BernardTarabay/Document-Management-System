const db = require("../config/database");
const { createBaseRepository } = require("./baseRepository");

const base = createBaseRepository("tags", { defaultOrderBy: "name ASC" });

async function findOrCreate(name, slug) {
  const { rows } = await db.query(
    `INSERT INTO tags (name, slug) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [name, slug]
  );
  return rows[0];
}

module.exports = { ...base, findOrCreate };
