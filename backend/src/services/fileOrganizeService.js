// Filing a document under a subject. THE one implementation.
//
// WHY THERE IS EXACTLY ONE
//
// The requirement is that no duplicate document silently enters the Subjects
// tree, whether the move came from a manual click, an AI suggestion, a bulk
// selection, or the automatic classifier. An invariant that has to hold across
// four callers cannot be enforced by four implementations that each remember
// to check -- the fourth one will not. So all four call `moveToSubject`, and
// the duplicate guard, the ownership check, the placement provenance and the
// audit entry live inside it.
//
// Bulk is a LOOP over this function, deliberately. It is slower than a single
// UPDATE ... WHERE id = ANY(...) and that is the correct trade: the fast
// version would skip the per-file duplicate check, which is the entire point.
// The requirement says it outright -- "do not create a separate fast path
// that bypasses safety checks".
//
// WHAT "MOVING" MEANS HERE
//
// Not a filesystem move. A file's placement in the tree is its latest
// classification_results row (see fileRepository.listBySubject for why the
// documents/document_subjects tables are not used). Originals on read-only
// locations are never touched; the organized view is the mirror and the UI.
const fileRepository = require("../repositories/fileRepository");
const subjectRepository = require("../repositories/subjectRepository");
const classificationResultRepository = require("../repositories/classificationResultRepository");
const auditLogRepository = require("../repositories/auditLogRepository");
const duplicateGuard = require("./duplicateGuard");
const pipelineState = require("./pipelineState");
const db = require("../config/database");
const { ValidationError } = require("../validators/validationError");
const { requireOwner } = require("../repositories/ownership");
const { ClassificationMethod, ConfidenceLevel } = require("../models/enums");

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
    this.publicMessage = message;
  }
}

/**
 * Who decided this file goes here. Recorded on the file so the UI can show
 * it, because "an AI action must never be hidden" is a property of the
 * PLACEMENT, not of whichever audit row happens to be most recent.
 */
const PlacementSource = Object.freeze({
  USER: "user",              // a person picked the destination
  AI_SUGGESTED: "ai_suggested", // the assistant proposed it, a person accepted
  AI_AUTO: "ai_auto",        // applied without review, under an explicit opt-in
  RULE: "rule",              // the deterministic classifier
});

const VALID_SOURCES = new Set(Object.values(PlacementSource));

/**
 * File one document under one subject.
 *
 * @param {object} args
 * @param {string} args.fileId
 * @param {string} args.subjectId
 * @param {string} args.ownerUserId
 * @param {string} [args.source] - PlacementSource; defaults to a user action
 * @param {string} [args.note] - why, shown next to the placement
 * @param {boolean} [args.confirmDuplicate] - the user has seen the findings
 *   and chosen to proceed anyway. Without it, a blocking finding stops the
 *   move and returns the findings instead.
 * @returns {Promise<{moved: boolean, file?: object, findings?: Array, requiresConfirmation?: boolean}>}
 */
async function moveToSubject({
  fileId, subjectId, ownerUserId,
  source = PlacementSource.USER, note = null, confirmDuplicate = false,
}) {
  requireOwner(ownerUserId, "fileOrganizeService.moveToSubject");
  if (!VALID_SOURCES.has(source)) throw new ValidationError(`Unknown placement source "${source}".`);

  // Both sides owner-scoped. This is the check that makes "move this file to
  // another user's folder" fail regardless of who or what asked -- an AI
  // proposal arrives here as the same call a button does, and gets the same
  // answer.
  const [file, subject] = await Promise.all([
    fileRepository.findByIdForOwner(fileId, ownerUserId),
    subjectRepository.findByIdForOwner(subjectId, ownerUserId),
  ]);
  if (!file) throw new NotFoundError("File not found.");
  if (!subject) throw new NotFoundError("Folder not found.");
  if (file.status === "deleted") {
    throw new ValidationError("This file has been removed. Restore it before filing it somewhere.");
  }

  // --- the guard --------------------------------------------------------
  const { findings, hasBlocking } = await duplicateGuard.check(fileId, ownerUserId, {
    targetSubjectId: subjectId,
  });

  if (hasBlocking && !confirmDuplicate) {
    // Not an error -- a question. The caller renders the findings with their
    // actions (view / compare / keep both / replace / cancel) and calls back
    // with confirmDuplicate once the user has chosen.
    return {
      moved: false,
      requiresConfirmation: true,
      findings,
      destination: { id: subject.id, name: subject.name, path: subject.materialized_path },
    };
  }

  // --- the move ---------------------------------------------------------
  // One transaction: the classification row and the placement provenance
  // describe the same decision, and a file whose provenance says "you chose
  // this" while its classification still points elsewhere is worse than
  // either failure alone.
  await db.withTransaction(async (client) => {
    await classificationResultRepository.create({
      fileId,
      classifiedSubjectId: subjectId,
      classifiedDocumentTypeId: null,
      confidenceLevel: source === PlacementSource.USER ? ConfidenceLevel.HIGH : ConfidenceLevel.MEDIUM,
      confidenceScore: source === PlacementSource.USER ? 1.0 : 0.75,
      method: source === PlacementSource.USER ? ClassificationMethod.MANUAL : ClassificationMethod.LLM,
      rawOutput: { placementSource: source, note },
    }, client);

    await client.query(
      `UPDATE files SET placement_source = $2, placement_at = now(), placement_note = $3
        WHERE id = $1`,
      [fileId, source, note]
    );
  });

  // Outside the transaction: both are bookkeeping that must not be able to
  // roll back the move itself.
  await subjectRepository.touchUsed(subjectId, ownerUserId);
  await pipelineState.markUserResolved(fileId, "moved");

  await auditLogRepository.record({
    userId: ownerUserId,
    action: "file.filed",
    entityType: "file",
    entityId: fileId,
    previousState: { placementSource: file.placement_source },
    newState: { subjectId, subjectName: subject.name, placementSource: source },
    reason:
      (source === PlacementSource.USER
        ? `Filed under "${subject.name}" from the UI`
        : source === PlacementSource.AI_SUGGESTED
          ? `Filed under "${subject.name}" -- suggested by the assistant, accepted by the user`
          : source === PlacementSource.AI_AUTO
            ? `Filed under "${subject.name}" automatically by the assistant`
            : `Filed under "${subject.name}" by the rule-based classifier`) +
      (findings.length
        ? `. ${findings.length} similar document(s) were flagged and the user chose to proceed.`
        : ""),
  });

  const updated = await fileRepository.findByIdForOwner(fileId, ownerUserId);
  return {
    moved: true,
    file: updated,
    // Returned even on success when the user confirmed past them, so the UI
    // can say "filed anyway, 2 similar documents noted" rather than pretending
    // the question was never asked.
    findings,
    destination: { id: subject.id, name: subject.name, path: subject.materialized_path },
  };
}

/**
 * File several documents in one action.
 *
 * A loop over moveToSubject, so every safety check applies per file. Reports
 * per-file outcomes rather than a single success/failure, because on a batch
 * of thirty the interesting answer is always "27 filed, 2 need a decision, 1
 * was not yours".
 *
 * Files needing duplicate confirmation are NOT skipped silently -- they come
 * back in `needsConfirmation` with their findings, and the UI walks the user
 * through them. Silently filing them would break the invariant; silently
 * dropping them would lose documents.
 */
async function moveManyToSubject({
  fileIds, subjectId, ownerUserId,
  source = PlacementSource.USER, note = null, confirmDuplicates = false,
}) {
  requireOwner(ownerUserId, "fileOrganizeService.moveManyToSubject");
  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    throw new ValidationError("Select at least one file to file.");
  }

  const owned = await fileRepository.listByIdsForOwner(fileIds, ownerUserId);
  const ownedIds = new Set(owned.map((f) => f.id));

  const results = { moved: [], needsConfirmation: [], failed: [], notFound: [] };

  for (const fileId of fileIds) {
    if (!ownedIds.has(fileId)) {
      // Reported, not silently dropped. A bulk action that quietly ignores
      // part of its input is how a user concludes files have vanished.
      results.notFound.push(fileId);
      continue;
    }
    try {
      const outcome = await moveToSubject({
        fileId, subjectId, ownerUserId, source, note,
        confirmDuplicate: confirmDuplicates,
      });
      if (outcome.moved) results.moved.push(fileId);
      else results.needsConfirmation.push({ fileId, findings: outcome.findings });
    } catch (err) {
      results.failed.push({ fileId, message: err.publicMessage || err.message });
    }
  }

  await auditLogRepository.record({
    userId: ownerUserId,
    action: "file.filed_bulk",
    entityType: "subject",
    entityId: subjectId,
    newState: {
      requested: fileIds.length,
      moved: results.moved.length,
      needsConfirmation: results.needsConfirmation.length,
      failed: results.failed.length,
      notFound: results.notFound.length,
      placementSource: source,
    },
    reason:
      `Bulk filing: ${results.moved.length} of ${fileIds.length} filed. ` +
      "Every file went through the same duplicate check as a single move.",
  });

  return results;
}

module.exports = { NotFoundError, PlacementSource, moveToSubject, moveManyToSubject };
