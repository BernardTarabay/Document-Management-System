const db = require("../config/database");
const { createBaseRepository } = require("./baseRepository");

const base = createBaseRepository("document_types", { defaultOrderBy: "name ASC" });

async function findByCode(code) {
  const { rows } = await db.query("SELECT * FROM document_types WHERE code = $1", [code]);
  return rows[0] || null;
}

module.exports = { ...base, findByCode };
