const db = require("../config/database");
const { createBaseRepository } = require("./baseRepository");

const base = createBaseRepository("roles", { defaultOrderBy: "name ASC" });

async function findByName(name) {
  const { rows } = await db.query("SELECT * FROM roles WHERE name = $1", [name]);
  return rows[0] || null;
}

module.exports = { ...base, findByName };
