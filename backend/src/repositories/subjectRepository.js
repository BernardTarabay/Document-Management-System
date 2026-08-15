// Hierarchical taxonomy access (see docs/03-taxonomy.md).
//
// Two changes from the original shape, both from migrations 028/029:
//
//   * every subject belongs to a user, and every read here is scoped to one
//   * the tree is no longer capped at three levels; `depth` is the structural
//     fact and `level` is a projection of it kept for existing readers
const db = require("../config/database");
const { createBaseRepository } = require("./baseRepository");
const { ownedRepository, requireOwner } = require("./ownership");

const base = createBaseRepository("subjects", { defaultOrderBy: "materialized_path ASC" });
const owned = ownedRepository(db, "subjects", { orderBy: "materialized_path ASC" });

async function listForOwnerTree(ownerUserId) {
  requireOwner(ownerUserId, "subjects.listForOwnerTree");
  const { rows } = await db.query(
    `SELECT * FROM subjects WHERE owner_user_id = $1 ORDER BY materialized_path ASC`,
    [ownerUserId]
  );
  return rows;
}

async function listChildren(parentId, ownerUserId) {
  requireOwner(ownerUserId, "subjects.listChildren");
  const { rows } = await db.query(
    `SELECT * FROM subjects
      WHERE parent_id IS NOT DISTINCT FROM $1 AND owner_user_id = $2
      ORDER BY name ASC`,
    [parentId, ownerUserId]
  );
  return rows;
}

async function listTopLevel(ownerUserId) {
  return listChildren(null, ownerUserId);
}

async function findByPath(materializedPath, ownerUserId) {
  requireOwner(ownerUserId, "subjects.findByPath");
  const { rows } = await db.query(
    "SELECT * FROM subjects WHERE materialized_path = $1 AND owner_user_id = $2",
    [materializedPath, ownerUserId]
  );
  return rows[0] || null;
}

/** All descendants of a subject, via the materialized path prefix. */
async function listSubtree(subjectId, ownerUserId) {
  const subject = await owned.findByIdForOwner(subjectId, ownerUserId);
  if (!subject) return [];
  const { rows } = await db.query(
    `SELECT * FROM subjects
     WHERE owner_user_id = $2
       AND (materialized_path = $1 OR materialized_path LIKE $1 || '.%')
     ORDER BY materialized_path ASC`,
    [subject.materialized_path, ownerUserId]
  );
  return rows;
}

/**
 * `level` and `materialized_path` are NOT passed in -- the trigger from
 * migration 029 derives both from the parent, so there is exactly one place
 * that decides where a row sits in the tree. Passing a level here would let a
 * caller assert a position the path contradicts.
 */
async function create({ ownerUserId, parentId = null, name, slug, description = null, origin = "user", aiRationale = null }) {
  requireOwner(ownerUserId, "subjects.create");
  const { rows } = await db.query(
    `INSERT INTO subjects
       (owner_user_id, parent_id, level, name, slug, materialized_path, description, origin, ai_rationale)
     VALUES ($1, $2, 'subject', $3, $4, '', $5, $6, $7) RETURNING *`,
    [ownerUserId, parentId, name, slug, description, origin, aiRationale]
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
async function update(id, ownerUserId, { name, description } = {}) {
  requireOwner(ownerUserId, "subjects.update");
  const fields = [];
  const values = [id, ownerUserId];
  let i = 3;

  if (name !== undefined) {
    fields.push(`name = $${i++}`);
    values.push(name);
  }
  if (description !== undefined) {
    fields.push(`description = $${i++}`);
    values.push(description);
  }
  if (fields.length === 0) return owned.findByIdForOwner(id, ownerUserId);

  const { rows } = await db.query(
    `UPDATE subjects SET ${fields.join(", ")}
      WHERE id = $1 AND owner_user_id = $2 RETURNING *`,
    values
  );
  return rows[0] || null;
}

/** Bumps "recently used", which is what makes the destination picker's
 *  shortlist reflect how this person actually files things. */
async function touchUsed(id, ownerUserId) {
  requireOwner(ownerUserId, "subjects.touchUsed");
  await db.query(
    "UPDATE subjects SET last_used_at = now() WHERE id = $1 AND owner_user_id = $2",
    [id, ownerUserId]
  );
}

/** The destinations this user filed something into most recently. */
async function listRecentlyUsed(ownerUserId, limit = 6) {
  requireOwner(ownerUserId, "subjects.listRecentlyUsed");
  const { rows } = await db.query(
    `SELECT * FROM subjects
      WHERE owner_user_id = $1 AND last_used_at IS NOT NULL
      ORDER BY last_used_at DESC LIMIT $2`,
    [ownerUserId, limit]
  );
  return rows;
}

/**
 * Root-to-leaf ancestor chain for a subject (e.g. subject "Budgets" under
 * top-level "Finance" -> [{Finance}, {Budgets}]). Used by namingService's
 * folder-placement logic to turn a classified Subject into an actual
 * folder path ("Finance/Budgets") without loading the whole taxonomy into
 * memory just to walk one chain.
 *
 * Unscoped by design: it is reached from worker code that already holds a
 * subject id taken off the file's own classification, and adding an owner
 * argument to every naming call site would be ceremony without a boundary
 * -- the id it walks up from was never user input.
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

/**
 * Give a brand-new account a starting tree.
 *
 * Six Subjects with a handful of Categories, exactly as before -- but they
 * are now this user's rows, deletable and renameable like anything else they
 * create, rather than a fixed global taxonomy every document had to be forced
 * into. `origin = 'seed'` records where they came from, so the UI can offer
 * "remove the starter folders you never used" without guessing.
 *
 * Kept deliberately small. The point of the dynamic tree is that it grows to
 * fit the documents, and a large speculative structure works against that by
 * making every new folder look like clutter next to twenty empty ones.
 */
const STARTER_TREE = [
  ["Personal", ["Identity", "Medical", "Receipts"]],
  ["Finance", ["Invoices", "Taxes", "Statements"]],
  ["Administrative", ["Certificates", "Government"]],
  ["Reference", []],
];

async function seedStarterTree(ownerUserId, slugify) {
  requireOwner(ownerUserId, "subjects.seedStarterTree");
  const created = [];
  for (const [parentName, children] of STARTER_TREE) {
    const parent = await create({
      ownerUserId, parentId: null, name: parentName,
      slug: slugify(parentName), origin: "seed",
    });
    created.push(parent);
    for (const childName of children) {
      created.push(await create({
        ownerUserId, parentId: parent.id, name: childName,
        slug: slugify(childName), origin: "seed",
      }));
    }
  }
  return created;
}

module.exports = {
  ...base, ...owned,
  listForOwnerTree, listChildren, listTopLevel, findByPath, listSubtree,
  create, update, touchUsed, listRecentlyUsed, getAncestorChain, seedStarterTree,
  STARTER_TREE,
};
