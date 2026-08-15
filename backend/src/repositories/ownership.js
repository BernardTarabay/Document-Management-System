// The one place that decides what "this row belongs to you" means.
//
// WHY THIS IS A MODULE AND NOT A CONVENTION
//
// Before ownership existed, every listing query was `WHERE status <> 'deleted'`
// and nothing else. Adding `AND owner_user_id = $1` to thirty query sites is
// easy; keeping it there is not. The failure mode is silent and total: one
// query that forgets the predicate returns another account's documents, and
// nothing about the response looks wrong -- there is no error, no empty list,
// no 403. It looks like the feature working.
//
// So the owner is never an optional argument here. `requireOwner` throws when
// it is missing, which converts "a developer forgot to thread the owner
// through" from a data leak into a 500 on the very first request in
// development. A loud failure that stops the request is the only kind of
// safety net worth having for this particular mistake.
//
// The same reasoning is why `buildFilterClauses` (fileFilters.js) emits the
// owner predicate itself rather than trusting callers: the four query paths
// that matter most already funnel through it.

/**
 * An owner id that is actually present.
 *
 * Deliberately refuses null/undefined/"" rather than treating them as "no
 * filter". `WHERE owner_user_id = NULL` matches nothing, which would look
 * like a harmless empty result -- but the callers that build SQL by
 * concatenation would simply omit the clause instead, and that matches
 * EVERYTHING. Neither behaviour should be reachable by accident.
 *
 * @param {string} ownerUserId
 * @param {string} [context] - what was being read, for the error message
 * @returns {string}
 */
function requireOwner(ownerUserId, context = "this query") {
  if (typeof ownerUserId !== "string" || ownerUserId.trim() === "") {
    throw new Error(
      `Ownership scope missing for ${context}. Every read of user-owned data must be ` +
      `scoped to a single owner; passing no owner would return every account's rows. ` +
      `Thread req.user.id down to this call.`
    );
  }
  return ownerUserId;
}

/**
 * Raised when a user asks for a row that exists but is not theirs.
 *
 * 404, NOT 403. A 403 confirms the id is real, which turns any endpoint
 * taking an id into an oracle for enumerating other accounts' files: the
 * attacker learns which uuids exist even though they can never read them.
 * "Not found" is both true from the caller's perspective -- it is not in
 * their repository -- and free of that signal.
 */
class NotOwnedError extends Error {
  constructor(entity = "That item") {
    const message = `${entity} was not found.`;
    super(message);
    this.name = "NotOwnedError";
    this.statusCode = 404;
    this.publicMessage = message;
  }
}

/**
 * Assert that a freshly-loaded row belongs to the caller.
 *
 * Used on the mutation paths, where the row has to be read anyway to be
 * changed. Reads should prefer scoping the query itself (`WHERE owner_user_id
 * = $n`) over loading-then-checking -- the check is only as good as the
 * developer remembering to call it, whereas a scoped query cannot return the
 * wrong row in the first place.
 *
 * @param {object|null} row - the row, or null if the id matched nothing
 * @param {string} ownerUserId
 * @param {string} [entity] - what to call it in the error
 */
function assertOwned(row, ownerUserId, entity = "That item") {
  requireOwner(ownerUserId, entity);
  if (!row || row.owner_user_id !== ownerUserId) throw new NotOwnedError(entity);
  return row;
}

/**
 * Extend `createBaseRepository` with owner-scoped variants.
 *
 * The unscoped `findById`/`list` from the base repository are intentionally
 * left in place: background workers legitimately operate on a file without a
 * user in context (a scan is triggered by a timer, not a session), and they
 * have already established which location -- and therefore which owner -- they
 * are working for. What they must never do is answer an HTTP request. The
 * naming makes the distinction visible at every call site: `findById` is the
 * worker's, `findByIdForOwner` is the API's.
 *
 * @param {object} db - the database module
 * @param {string} table
 * @param {object} [opts]
 * @param {string} [opts.orderBy]
 */
function ownedRepository(db, table, { orderBy = "created_at DESC" } = {}) {
  return {
    async findByIdForOwner(id, ownerUserId) {
      requireOwner(ownerUserId, `${table}.findByIdForOwner`);
      const { rows } = await db.query(
        `SELECT * FROM ${table} WHERE id = $1 AND owner_user_id = $2`,
        [id, ownerUserId]
      );
      return rows[0] || null;
    },

    async listForOwner(ownerUserId, { limit = 50, offset = 0 } = {}) {
      requireOwner(ownerUserId, `${table}.listForOwner`);
      const { rows } = await db.query(
        `SELECT * FROM ${table} WHERE owner_user_id = $1
         ORDER BY ${orderBy} LIMIT $2 OFFSET $3`,
        [ownerUserId, limit, offset]
      );
      return rows;
    },

    async countForOwner(ownerUserId) {
      requireOwner(ownerUserId, `${table}.countForOwner`);
      const { rows } = await db.query(
        `SELECT COUNT(*)::int AS count FROM ${table} WHERE owner_user_id = $1`,
        [ownerUserId]
      );
      return rows[0].count;
    },

    /** Returns the deleted row, or null when it was not the caller's to delete. */
    async deleteByIdForOwner(id, ownerUserId) {
      requireOwner(ownerUserId, `${table}.deleteByIdForOwner`);
      const { rows } = await db.query(
        `DELETE FROM ${table} WHERE id = $1 AND owner_user_id = $2 RETURNING *`,
        [id, ownerUserId]
      );
      return rows[0] || null;
    },
  };
}

module.exports = { requireOwner, assertOwned, NotOwnedError, ownedRepository };
