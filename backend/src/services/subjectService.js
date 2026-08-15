const subjectRepository = require("../repositories/subjectRepository");
const fileRepository = require("../repositories/fileRepository");
const auditLogRepository = require("../repositories/auditLogRepository");
const { parseFileFilters } = require("../repositories/fileFilters");
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

// Postgres FK-violation SQLSTATE. Used to translate a raw constraint error
// into a message someone editing the Subjects page can actually act on.
const FOREIGN_KEY_VIOLATION = "23503";
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

  return subjects.map((subject) => {
    const direct = counts[subject.id] || 0;
    const prefix = `${subject.materialized_path}.`;
    const total = subjects.reduce((sum, other) => {
      if (other.id === subject.id) return sum + direct;
      // A descendant's path starts with this subject's path plus a dot.
      // The dot matters: without it "finance" would also swallow
      // "financeplanning".
      return other.materialized_path?.startsWith(prefix) ? sum + (counts[other.id] || 0) : sum;
    }, 0);

    return { ...subject, fileCount: direct, totalFileCount: total };
  });
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
  return fileRepository.listBySubject(subjectId, { limit, offset, filters });
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

async function remove(id, actorUserId) {
  const subject = await subjectRepository.findByIdForOwner(id, actorUserId);
  if (!subject) throw new NotFoundError("Subject not found.");

  const children = await subjectRepository.listChildren(id, actorUserId);
  if (children.length > 0) {
    throw new ValidationError(
      `"${subject.name}" has ${children.length} folder${children.length === 1 ? "" : "s"} inside it. Delete or move those first.`
    );
  }

  const filesInUse = await fileRepository.countBySubject(id, actorUserId);
  if (filesInUse > 0) {
    throw new ValidationError(
      `${filesInUse} file${filesInUse === 1 ? " is" : "s are"} currently filed under "${subject.name}". Move them somewhere else first.`
    );
  }

  try {
    const deleted = await subjectRepository.deleteByIdForOwner(id, actorUserId);
    if (!deleted) throw new NotFoundError("Subject not found.");
  } catch (err) {
    // Every reclassification keeps its old classification_results row for
    // history (see fileService.updateFile) -- a subject that was EVER
    // assigned to a file, even one long since moved elsewhere, still has a
    // row referencing it, and that FK has no ON DELETE clause (NO ACTION).
    // The two checks above only rule out subjects that are *currently* in
    // use; this catches the "used in the past" case with an explanation
    // instead of a raw constraint error.
    if (err.code === FOREIGN_KEY_VIOLATION) {
      throw new ValidationError(
        `"${subject.name}" can't be deleted -- files have been filed under it in the past and that history is kept for audit purposes. Rename it instead, or leave it in place unused.`
      );
    }
    throw err;
  }

  await auditLogRepository.record({
    userId: actorUserId,
    action: "subject.deleted",
    entityType: "subject",
    entityId: id,
    previousState: { name: subject.name, parentId: subject.parent_id, depth: subject.depth },
    reason: "Deleted from the Subjects page",
  });

  return { success: true };
}

module.exports = {
  NotFoundError, MAX_DEPTH,
  list, listRecentDestinations, getDocumentsForSubject, create, update, remove, slugify,
};
