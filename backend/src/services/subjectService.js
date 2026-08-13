const subjectRepository = require("../repositories/subjectRepository");
const fileRepository = require("../repositories/fileRepository");
const auditLogRepository = require("../repositories/auditLogRepository");
const { parseFileFilters } = require("../repositories/fileFilters");
const { parsePagination } = require("../utils/pagination");
const { ValidationError } = require("../validators/validationError");
const { SubjectLevel } = require("../models/enums");

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
async function list(query = {}) {
  // The tree honours the same filters as the lists it links to. Without
  // this, filtering to PDFs would leave every branch showing its unfiltered
  // total and then open to a much shorter list -- the number would be
  // describing a view you are no longer looking at.
  const filters = parseFileFilters(query);
  const [subjects, counts] = await Promise.all([
    subjectRepository.list({ limit: 1000 }),
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

async function getDocumentsForSubject(subjectId, query) {
  const subject = await subjectRepository.findById(subjectId);
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
  const filters = parseFileFilters(query);

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

/** Subject -> Category -> Subcategory, per docs/03-taxonomy.md §3.2. */
function levelBelow(parentLevel) {
  if (parentLevel === SubjectLevel.SUBJECT) return SubjectLevel.CATEGORY;
  if (parentLevel === SubjectLevel.CATEGORY) return SubjectLevel.SUBCATEGORY;
  return null; // subcategory has no level below it
}

async function create({ parentId, name, description }, actorUserId) {
  const trimmedName = String(name || "").trim();
  if (!trimmedName) throw new ValidationError("name is required.");

  let level = SubjectLevel.SUBJECT;
  let parent = null;
  if (parentId) {
    parent = await subjectRepository.findById(parentId);
    if (!parent) throw new ValidationError("Parent subject not found.");
    level = levelBelow(parent.level);
    if (!level) {
      throw new ValidationError(
        "Subjects can only be nested three levels deep (Subject → Category → Subcategory)."
      );
    }
  }

  const slug = slugify(trimmedName);

  let subject;
  try {
    subject = await subjectRepository.create({
      parentId: parentId || null,
      level,
      name: trimmedName,
      slug,
      description: description ? String(description).trim() || null : null,
    });
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      throw new ValidationError(`A subject named "${trimmedName}" already exists at this level.`);
    }
    throw err;
  }

  await auditLogRepository.record({
    userId: actorUserId,
    action: "subject.created",
    entityType: "subject",
    entityId: subject.id,
    newState: { name: subject.name, parentId: subject.parent_id, level: subject.level },
    reason: "Created from the Subjects page",
  });

  return subject;
}

async function update(id, { name, description }, actorUserId) {
  const subject = await subjectRepository.findById(id);
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

  const updated = await subjectRepository.update(id, patch);

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
  const subject = await subjectRepository.findById(id);
  if (!subject) throw new NotFoundError("Subject not found.");

  const children = await subjectRepository.listChildren(id);
  if (children.length > 0) {
    throw new ValidationError(
      `"${subject.name}" has ${children.length} subcategor${children.length === 1 ? "y" : "ies"} under it. Delete or move those first.`
    );
  }

  const filesInUse = await fileRepository.countBySubject(id);
  if (filesInUse > 0) {
    throw new ValidationError(
      `${filesInUse} file${filesInUse === 1 ? " is" : "s are"} currently classified under "${subject.name}". Move them to another subject first.`
    );
  }

  try {
    await subjectRepository.deleteById(id);
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
        `"${subject.name}" can't be deleted -- files have been classified under it in the past and that history is kept for audit purposes. Rename it instead, or leave it in place unused.`
      );
    }
    throw err;
  }

  await auditLogRepository.record({
    userId: actorUserId,
    action: "subject.deleted",
    entityType: "subject",
    entityId: id,
    previousState: { name: subject.name, parentId: subject.parent_id, level: subject.level },
    reason: "Deleted from the Subjects page",
  });

  return { success: true };
}

module.exports = { NotFoundError, list, getDocumentsForSubject, create, update, remove, slugify, levelBelow };
