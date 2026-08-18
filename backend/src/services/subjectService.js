const subjectRepository = require("../repositories/subjectRepository");
const fileRepository = require("../repositories/fileRepository");
const auditLogRepository = require("../repositories/auditLogRepository");
const { parseFileFilters, parseSort } = require("../repositories/fileFilters");
const { requireOwner } = require("../repositories/ownership");
const { parsePagination } = require("../utils/pagination");
const { ValidationError } = require("../validators/validationError");

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
    this.publicMessage = message;
  }
}

const UNIQUE_VIOLATION = "23505";

/**
 * How deep the tree may go.
 *
 * There used to be a hard cap of three (Subject -> Category -> Subcategory),
 * and it was the mechanism behind "documents get forced into categories that
 * do not fit": with no room to nest, the only way to file something new was to
 * pick the least-wrong existing bucket, and the classifier did exactly that.
 *
 * This cap is a guard rail rather than a taxonomy. It exists only to stop
 * runaway nesting -- an accidental loop of "create a folder inside the one I
 * just made" -- at a depth no human filing system reaches. materialized_path
 * is a dot-joined chain of slugs, so unbounded depth is also an unbounded key.
 */
const MAX_DEPTH = 12;

/**
 * Every subject, each carrying how many files sit under it.
 *
 * Two numbers, because they answer different questions:
 *  - fileCount:      files classified directly into this subject
 *  - totalFileCount: that plus everything in its descendants
 *
 * A parent like "Finance" usually holds nothing directly while its
 * children hold everything, so showing only the direct count would label
 * most branches "0" and make the tree look empty. The rollup uses
 * materialized_path (an ltree-style "finance.reports" key the DB maintains),
 * so it needs no recursion here.
 */
async function list(query = {}, ownerUserId) {
  requireOwner(ownerUserId, "subjectService.list");
  // The tree honours the same filters as the lists it links to. Without
  // this, filtering to PDFs would leave every branch showing its unfiltered
  // total and then open to a much shorter list -- the number would be
  // describing a view you are no longer looking at.
  const filters = parseFileFilters(query, ownerUserId);
  const [subjects, counts] = await Promise.all([
    subjectRepository.listForOwnerTree(ownerUserId),
    fileRepository.countsBySubject({ filters }),
  ]);

  /**
   * ROLL THE COUNTS UP IN ONE PASS, NOT n PASSES.
   *
   * This was a `subjects.reduce(...)` nested inside a `subjects.map(...)`,
   * doing a string `startsWith` on every pair -- O(n^2). It is invisible on a
   * demo taxonomy and fatal on a real one: measured against a generated tree of
   * 46,022 folders (scripts/generate-pilot-corpus.js --subjects), one
   * GET /subjects took **114 seconds**, which is not a slow page, it is a page
   * that never arrives. 46,000 squared is 2.1 billion string comparisons per
   * request.
   *
   * The rollup does not need pair-wise comparison at all. materialized_path is
   * a dot-joined chain of slugs, so a folder's ancestors ARE its own path
   * truncated at each dot: "finance.reports.2019" rolls up into
   * "finance.reports" and "finance". So each folder's direct count is added to
   * itself and to each of its ancestor prefixes, once -- O(n x depth), and
   * depth is capped at MAX_DEPTH.
   *
   * Splitting on the separator also keeps the property the old comment was
   * careful about: "finance" cannot swallow "financeplanning", because the
   * prefixes compared are whole path components, not string prefixes.
   */
  const totals = new Map();
  for (const subject of subjects) {
    const direct = counts[subject.id] || 0;
    if (!direct) continue;
    const path = subject.materialized_path;
    if (!path) continue;

    const parts = path.split(".");
    for (let i = parts.length; i >= 1; i -= 1) {
      const ancestorPath = i === parts.length ? path : parts.slice(0, i).join(".");
      totals.set(ancestorPath, (totals.get(ancestorPath) || 0) + direct);
    }
  }

  return subjects.map((subject) => ({
    ...subject,
    fileCount: counts[subject.id] || 0,
    totalFileCount: subject.materialized_path ? totals.get(subject.materialized_path) || 0 : counts[subject.id] || 0,
  }));
}

/**
 * The destination picker's shortlist: folders this person has filed into
 * recently, most recent first.
 *
 * Recency beats alphabetical for this specific job. Someone importing a
 * batch of receipts files twenty documents into the same folder in a row, and
 * making them find it in a tree each time is the friction the picker exists
 * to remove.
 */
async function listRecentDestinations(ownerUserId, limit = 6) {
  requireOwner(ownerUserId, "subjectService.listRecentDestinations");
  const rows = await subjectRepository.listRecentlyUsed(ownerUserId, limit);
  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    path: s.materialized_path,
    depth: s.depth,
    lastUsedAt: s.last_used_at,
  }));
}

async function getDocumentsForSubject(subjectId, query, ownerUserId) {
  const subject = await subjectRepository.findByIdForOwner(subjectId, ownerUserId);
  if (!subject) throw new NotFoundError("Subject not found.");
  const { limit, offset } = parsePagination(query);

  // Searching WITHIN a subject. Same engine as the Files page -- content,
  // AI title, summary and filename, ranked, with a highlighted excerpt --
  // just scoped to this branch. Someone who already knows the document is
  // filed under Finance should not have to sift the whole repository to
  // find it.
  // Filters stack ON TOP of the subject you have open, rather than replacing
  // it: you are browsing a branch and narrowing within it. `subjectId` here
  // is the exact-match scope, deliberately not the descendant-inclusive
  // subject FILTER -- see the note on fileRepository.searchEverything.
  const filters = parseFileFilters(query, ownerUserId);

  if (query?.q && String(query.q).trim()) {
    return fileRepository.searchEverything(String(query.q).trim(), { limit, offset, subjectId, filters });
  }
  // Sourced from files' latest classification result, not the separate
  // (and never-populated-by-this-pipeline) documents/document_subjects
  // tables -- see fileRepository.listBySubject for why.
  //
  // Sorted only on the browse path, not the search path above: search results
  // arrive ranked by relevance, and re-sorting them by size discards the
  // ranking that made them worth returning.
  return fileRepository.listBySubject(subjectId, { limit, offset, filters, sort: parseSort(query) });
}

/**
 * How many files sit directly under this subject, honouring the same filters.
 *
 * Separate from the list for the same reason GET /files/count is separate from
 * GET /files: the list returns a bare array that several callers already
 * consume, and one cheap extra request beats changing that shape for all of
 * them. Without this the pager can only say "page 3", never "page 3 of 62",
 * which is the difference between navigating an archive and wandering it.
 */
async function countDocumentsForSubject(subjectId, query, ownerUserId) {
  const subject = await subjectRepository.findByIdForOwner(subjectId, ownerUserId);
  if (!subject) throw new NotFoundError("Subject not found.");
  const filters = parseFileFilters(query, ownerUserId);
  return { count: await fileRepository.countInSubject(subjectId, { filters }) };
}

/**
 * name -> slug for the (parent_id, slug) uniqueness constraint and the
 * materialized_path the DB trigger derives from it. Deliberately simple --
 * this is an internal key, not something shown to the user (they see
 * `name`), so it doesn't need to preserve non-Latin scripts perfectly, just
 * be stable and collision-resistant for the common case.
 */
function slugify(name) {
  const slug = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "subject";
}

/**
 * Create a folder anywhere in the tree.
 *
 * `origin` records whose idea it was -- 'user', 'ai' (the assistant proposed
 * it and a human accepted), or 'seed' (the starter tree). The requirement is
 * that automated decisions are never hidden, and a folder that appeared
 * because a model suggested it is exactly such a decision; the Subjects page
 * badges it and shows `aiRationale` so it can be judged rather than merely
 * discovered.
 */
async function create({ parentId, name, description, origin = "user", aiRationale = null }, actorUserId) {
  requireOwner(actorUserId, "subjectService.create");
  const trimmedName = String(name || "").trim();
  if (!trimmedName) throw new ValidationError("name is required.");

  let parent = null;
  if (parentId) {
    // Owner-scoped: nesting under somebody else's folder is refused here, not
    // merely absent from the picker.
    parent = await subjectRepository.findByIdForOwner(parentId, actorUserId);
    if (!parent) throw new ValidationError("Parent subject not found.");
    if (parent.depth + 1 > MAX_DEPTH) {
      throw new ValidationError(
        `Folders can be nested up to ${MAX_DEPTH} levels deep. "${parent.name}" is already at that limit.`
      );
    }
  }

  const slug = slugify(trimmedName);

  let subject;
  try {
    subject = await subjectRepository.create({
      ownerUserId: actorUserId,
      parentId: parentId || null,
      name: trimmedName,
      slug,
      description: description ? String(description).trim() || null : null,
      origin,
      aiRationale,
    });
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      throw new ValidationError(`A folder named "${trimmedName}" already exists here.`);
    }
    throw err;
  }

  await auditLogRepository.record({
    userId: actorUserId,
    action: "subject.created",
    entityType: "subject",
    entityId: subject.id,
    newState: { name: subject.name, parentId: subject.parent_id, depth: subject.depth, origin },
    reason: origin === "ai"
      ? `Created from an assistant suggestion${aiRationale ? `: ${aiRationale}` : ""}`
      : "Created from the Subjects page",
  });

  return subject;
}

async function update(id, { name, description }, actorUserId) {
  const subject = await subjectRepository.findByIdForOwner(id, actorUserId);
  if (!subject) throw new NotFoundError("Subject not found.");

  const patch = {};
  if (name !== undefined) {
    const trimmedName = String(name).trim();
    if (!trimmedName) throw new ValidationError("name cannot be empty.");
    patch.name = trimmedName;
  }
  if (description !== undefined) {
    patch.description = description ? String(description).trim() || null : null;
  }

  if (Object.keys(patch).length === 0) return subject;

  const updated = await subjectRepository.update(id, actorUserId, patch);

  await auditLogRepository.record({
    userId: actorUserId,
    action: "subject.renamed",
    entityType: "subject",
    entityId: id,
    previousState: { name: subject.name, description: subject.description },
    newState: { name: updated.name, description: updated.description },
    reason: "Edited from the Subjects page",
  });

  return updated;
}

/**
 * What deleting this folder would take with it.
 *
 * Exposed so the confirmation can NAME the consequences rather than ask "are
 * you sure?" about an unknown quantity. "Delete Photos, 3 folders inside it,
 * and unfile 128 documents" is a decision someone can make; "are you sure?" is
 * a coin toss they will click through.
 */
/**
 * Drag a folder into another folder -- ordinary file-manager behaviour, which
 * this tree did not have. The moved folder becomes a child of the destination;
 * everything inside it comes along.
 *
 * Three things have to be refused, and each has a reason a person can act on:
 *
 *   into itself / its own branch   would detach the branch from the tree
 *                                  entirely -- it would still exist, reachable
 *                                  from nothing, which is worse than an error
 *   past the depth limit           the whole branch moves, so what matters is
 *                                  the DEEPEST folder in it, not the one being
 *                                  dragged
 *   a name already used there      allowed elsewhere, but two identical names
 *                                  inside one parent is almost never intended
 */
async function moveToParent(id, newParentId, actorUserId) {
  requireOwner(actorUserId, "subjectService.moveToParent");

  const subject = await subjectRepository.findByIdForOwner(id, actorUserId);
  if (!subject) throw new NotFoundError("Subject not found.");

  const targetParentId = newParentId || null;
  if (targetParentId === subject.parent_id) {
    return { subject, movedDescendants: 0, unchanged: true };
  }

  const subtree = await subjectRepository.listSubtree(id, actorUserId);

  let parent = null;
  if (targetParentId) {
    if (targetParentId === id) {
      throw new ValidationError(`"${subject.name}" cannot be moved inside itself.`);
    }
    parent = await subjectRepository.findByIdForOwner(targetParentId, actorUserId);
    if (!parent) throw new ValidationError("Destination folder not found.");

    // A descendant of the folder being moved. Checked on the subtree we
    // already have rather than by path prefix, so it holds regardless of how
    // paths are spelled.
    if (subtree.some((s) => s.id === targetParentId)) {
      throw new ValidationError(
        `"${subject.name}" cannot be moved into "${parent.name}", because that folder is inside it.`
      );
    }

    // The DEEPEST folder in the branch decides whether the move fits.
    const branchHeight = subtree.reduce((max, s) => Math.max(max, s.depth - subject.depth), 0);
    const newDepth = parent.depth + 1 + branchHeight;
    if (newDepth > MAX_DEPTH) {
      throw new ValidationError(
        `That would nest folders ${newDepth + 1} levels deep, past the limit of ${MAX_DEPTH + 1}. ` +
        "Move it somewhere shallower, or flatten the branch first."
      );
    }
  }

  const siblings = targetParentId
    ? await subjectRepository.listChildren(targetParentId, actorUserId)
    : (await subjectRepository.listForOwnerTree(actorUserId)).filter((s) => !s.parent_id);
  const clash = siblings.find(
    (s) => s.id !== id && s.name.trim().toLowerCase() === subject.name.trim().toLowerCase()
  );
  if (clash) {
    throw new ValidationError(
      `There is already a folder called "${clash.name}" ${parent ? `inside "${parent.name}"` : "at the top level"}. ` +
      "Rename one of them first."
    );
  }

  const result = await subjectRepository.reparent(id, targetParentId, actorUserId);
  if (!result) throw new NotFoundError("Subject not found.");

  await auditLogRepository.record({
    userId: actorUserId,
    action: "subject.moved",
    entityType: "subject",
    entityId: id,
    previousState: { parentId: subject.parent_id, path: subject.materialized_path, depth: subject.depth },
    newState: {
      parentId: targetParentId,
      path: result.subject.materialized_path,
      depth: result.subject.depth,
      descendantsMoved: result.movedDescendants,
    },
    reason: parent
      ? `Moved "${subject.name}" into "${parent.name}"`
      : `Moved "${subject.name}" to the top level`,
  });

  return result;
}

async function previewRemoval(id, actorUserId) {
  const subject = await subjectRepository.findByIdForOwner(id, actorUserId);
  if (!subject) throw new NotFoundError("Subject not found.");

  const subtree = await subjectRepository.listSubtree(id, actorUserId);
  const descendants = subtree.filter((s) => s.id !== id);

  // Files across the WHOLE branch, not just this folder: deleting a parent
  // takes its children with it (subjects.parent_id is ON DELETE CASCADE), so
  // counting only the top folder would understate it, sometimes by everything.
  let filesAffected = 0;
  for (const node of subtree) {
    filesAffected += await fileRepository.countBySubject(node.id, actorUserId);
  }

  return {
    id, name: subject.name,
    subfolders: descendants.length,
    filesAffected,
    // Nothing is deleted from disk and no document is removed -- they lose
    // their folder and reappear in the Unfiled pile. Said explicitly because
    // "delete" next to a document count reads as "delete the documents".
    documentsDeleted: 0,
  };
}

/**
 * Delete a folder.
 *
 * WHY THIS NO LONGER REFUSES ON HISTORY
 *
 * It used to catch the foreign-key violation from classification_results and
 * tell the user a folder "can't be deleted -- files have been filed under it
 * in the past and that history is kept for audit purposes. Rename it instead."
 * That is not an answer to "I do not want this folder": it refuses on grounds
 * the user cannot act on and offers a workaround that leaves the clutter in
 * place under a different name. On a library whose premise is that the tree is
 * the user's, a folder that cannot be removed is a folder the software owns.
 *
 * Migration 036 makes that FK ON DELETE SET NULL, so historical rows keep
 * their method, confidence and timestamps and simply stop pointing at a folder
 * that no longer exists. History that mattered is kept; a dangling reference
 * is not history.
 *
 * WHAT STILL STOPS IT, AND WHY THAT IS DIFFERENT
 *
 * Deleting a branch or unfiling documents are real consequences, so they are
 * confirmed rather than refused: without `force` this throws an error that
 * NAMES them, and with `force` it proceeds. The distinction is between "you
 * cannot do this" (which was wrong) and "here is what this does, say yes"
 * (which is the same shape as every other destructive action here).
 */
async function remove(id, actorUserId, { force = false, contents = "unfile" } = {}) {
  const subject = await subjectRepository.findByIdForOwner(id, actorUserId);
  if (!subject) throw new NotFoundError("Subject not found.");

  const preview = await previewRemoval(id, actorUserId);

  if (!force) {
    if (preview.subfolders > 0) {
      throw new ValidationError(
        `"${subject.name}" has ${preview.subfolders} folder${preview.subfolders === 1 ? "" : "s"} inside it` +
        (preview.filesAffected > 0
          ? ` and ${preview.filesAffected} document${preview.filesAffected === 1 ? " is" : "s are"} filed in that branch`
          : "") +
        ". Confirm to delete the whole branch."
      );
    }
    if (preview.filesAffected > 0) {
      throw new ValidationError(
        `${preview.filesAffected} document${preview.filesAffected === 1 ? " is" : "s are"} filed under "${subject.name}". ` +
        "Confirm to delete it anyway -- they become unfiled, and no document is removed."
      );
    }
  }

  /**
   * WHAT HAPPENS TO THE DOCUMENTS INSIDE.
   *
   *   "unfile"  (default) they lose their folder and reappear in the Unfiled
   *             pile. Nothing is destroyed, and the folder is gone.
   *   "trash"   they go to the Trash with the folder, recoverable for the
   *             retention window and removed for good after it.
   *
   * There is deliberately no third option that deletes the documents outright.
   * Trash is the route to permanent deletion for everything else in this
   * application, and a folder delete is a bad place to introduce a second one:
   * it is an action about ORGANISATION, and someone tidying their tree should
   * not be one confirmation away from destroying documents.
   */
  if (contents === "trash" && preview.filesAffected > 0) {
    const subtree = await subjectRepository.listSubtree(id, actorUserId);
    const ids = [];
    for (const node of subtree) {
      // Owner-scoped filters, not null: buildFilterClauses requires an owner
      // and throws without one -- which is the guard doing its job, since a
      // null-filter read here would enumerate every account's files.
      const rows = await fileRepository.listBySubject(node.id, {
        limit: 5000, filters: parseFileFilters({}, actorUserId),
      });
      for (const row of rows) ids.push(row.id);
    }
    if (ids.length) {
      // Reuses the same path the Trash button uses, so a document trashed with
      // its folder is indistinguishable from one trashed on its own -- same
      // status, same timestamp, same retention, same restore.
      const lifecycleService = require("./lifecycleService");
      await lifecycleService.moveFiles(ids, "trash", actorUserId);
    }
  }

  const deleted = await subjectRepository.deleteByIdForOwner(id, actorUserId);
  if (!deleted) throw new NotFoundError("Subject not found.");

  await auditLogRepository.record({
    userId: actorUserId,
    action: "subject.deleted",
    entityType: "subject",
    entityId: id,
    previousState: { name: subject.name, parentId: subject.parent_id, depth: subject.depth },
    newState: {
      subfoldersRemoved: preview.subfolders,
      documentsAffected: preview.filesAffected,
      contents,
      forced: force,
    },
    reason:
      `Deleted "${subject.name}"` +
      (preview.subfolders ? ` and ${preview.subfolders} folder(s) inside it` : "") +
      (preview.filesAffected
        ? `; ${preview.filesAffected} document(s) ${contents === "trash" ? "moved to the Trash" : "became unfiled"}`
        : ""),
  });

  return { success: true };
}

module.exports = {
  NotFoundError, MAX_DEPTH,
  list, listRecentDestinations, getDocumentsForSubject, countDocumentsForSubject,
  create, update, remove, previewRemoval, moveToParent, slugify,
};
