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
/**
 * Move a folder under a new parent, and drag its whole branch along with it.
 *
 * WHY THIS IS NOT `update({ parentId })`
 *
 * `update` excludes parent_id on purpose, and its comment says why: the
 * migration-029 trigger recomputes materialized_path, depth and level for the
 * ROW BEING WRITTEN only. Move a folder with children that way and the folder
 * lands correctly while every descendant keeps a path spelling out an ancestry
 * it no longer has -- and materialized_path is what the descendant-inclusive
 * subject filter, the count rollup and the tree itself are all built on. The
 * damage would be silent and everywhere.
 *
 * So the branch is rewritten in the same transaction: the trigger fixes the
 * moved row, and the second statement re-prefixes its descendants. Their slugs
 * do not change, only the ancestry in front of them, so a string replacement of
 * the old prefix is exactly right.
 *
 * The path is a dot-joined chain of slugs (letters, digits and hyphens -- see
 * subjectService.slugify), so it carries no LIKE metacharacters and the prefix
 * match needs no escaping.
 *
 * Cycle and depth checks live in the service, where they can produce messages
 * about folders rather than about constraints.
 */
async function reparent(id, newParentId, ownerUserId) {
  requireOwner(ownerUserId, "subjects.reparent");

  return db.withTransaction(async (client) => {
    const { rows: [node] } = await client.query(
      "SELECT * FROM subjects WHERE id = $1 AND owner_user_id = $2 FOR UPDATE",
      [id, ownerUserId]
    );
    if (!node) return null;

    const oldPath = node.materialized_path;
    const oldDepth = node.depth;

    // The trigger recomputes this row's path, depth and level from the parent.
    const { rows: [moved] } = await client.query(
      "UPDATE subjects SET parent_id = $2 WHERE id = $1 AND owner_user_id = $3 RETURNING *",
      [id, newParentId, ownerUserId]
    );
    if (!moved) return null;

    const depthDelta = moved.depth - oldDepth;

    // Descendants: swap the old ancestry prefix for the new one and shift
    // depth by the same amount the moved folder shifted. `level` is a
    // projection of depth (migration 029) and is maintained here too, since
    // this UPDATE touches neither parent_id nor slug and so does not fire the
    // trigger that would otherwise keep it in step.
    const { rowCount: movedDescendants } = await client.query(
      `UPDATE subjects
          SET materialized_path = $3 || substring(materialized_path from length($2) + 1),
              depth = depth + $4,
              level = CASE depth + $4 WHEN 0 THEN 'subject' WHEN 1 THEN 'category'
                                      ELSE 'subcategory' END::subject_level
        WHERE owner_user_id = $1
          AND materialized_path LIKE $2 || '.%'`,
      [ownerUserId, oldPath, moved.materialized_path, depthDelta]
    );

    return { subject: moved, movedDescendants };
  });
}

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

module.exports = {
  ...base, ...owned,
  listForOwnerTree, listChildren, listTopLevel, findByPath, listSubtree,
  create, update, reparent, touchUsed, listRecentlyUsed, getAncestorChain,
};
