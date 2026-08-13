// Hierarchical taxonomy access (see docs/03-taxonomy.md).
const db = require("../config/database");
const { createBaseRepository } = require("./baseRepository");

const base = createBaseRepository("subjects", { defaultOrderBy: "materialized_path ASC" });

async function listChildren(parentId) {
  const { rows } = await db.query(
    "SELECT * FROM subjects WHERE parent_id IS NOT DISTINCT FROM $1 ORDER BY name ASC",
    [parentId]
  );
  return rows;
}

async function listTopLevel() {
  return listChildren(null);
}

async function findByPath(materializedPath) {
  const { rows } = await db.query(
    "SELECT * FROM subjects WHERE materialized_path = $1",
    [materializedPath]
  );
  return rows[0] || null;
}

/** All descendants of a subject, via the materialized path prefix. */
async function listSubtree(subjectId) {
  const subject = await base.findById(subjectId);
  if (!subject) return [];
  const { rows } = await db.query(
    `SELECT * FROM subjects
     WHERE materialized_path = $1 OR materialized_path LIKE $1 || '.%'
     ORDER BY materialized_path ASC`,
    [subject.materialized_path]
  );
  return rows;
}

async function create({ parentId = null, level, name, slug, description = null }) {
  const { rows } = await db.query(
    `INSERT INTO subjects (parent_id, level, name, slug, materialized_path, description)
     VALUES ($1, $2, $3, $4, '', $5) RETURNING *`,
    [parentId, level, name, slug, description]
  );
  return rows[0];
}

/**
 * Rename/redescribe a subject in place. Deliberately narrower than a
 * generic column-by-column updater: `slug`/`parent_id` are excluded on
 * purpose, since changing either would require recomputing
 * materialized_path for every descendant (the DB trigger only recomputes
 * the row being written, see migrations/011_indexes_search.sql), and the
 * product ask is "rename the subject," not "restructure the tree."
 */
async function update(id, { name, description } = {}) {
  const fields = [];
  const values = [];
  let i = 1;

  if (name !== undefined) {
    fields.push(`name = $${i++}`);
    values.push(name);
  }
  if (description !== undefined) {
    fields.push(`description = $${i++}`);
    values.push(description);
  }
  if (fields.length === 0) return base.findById(id);

  values.push(id);
  const { rows } = await db.query(
    `UPDATE subjects SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
    values
  );
  return rows[0] || null;
}

/**
 * Root-to-leaf ancestor chain for a subject (e.g. subject "Budgets" under
 * top-level "Finance" -> [{Finance}, {Budgets}]). Used by namingService's
 * folder-placement logic to turn a classified Subject into an actual
 * folder path ("Finance/Budgets") without loading the whole taxonomy into
 * memory just to walk one chain.
 */
async function getAncestorChain(subjectId) {
  const { rows } = await db.query(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_id, name, slug, 0 AS depth FROM subjects WHERE id = $1
       UNION ALL
       SELECT s.id, s.parent_id, s.name, s.slug, a.depth + 1
       FROM subjects s JOIN ancestors a ON s.id = a.parent_id
     )
     SELECT id, name, slug FROM ancestors ORDER BY depth DESC`,
    [subjectId]
  );
  return rows;
}

module.exports = { ...base, listChildren, listTopLevel, findByPath, listSubtree, create, update, getAncestorChain };
