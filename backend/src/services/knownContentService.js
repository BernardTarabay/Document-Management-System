// Adopting the results of an identical file instead of recomputing them.
//
// THE PROBLEM THIS SOLVES
//
// Register a second folder that overlaps one already indexed -- a backup of
// the same drive, a copy someone made before reorganising, the same archive
// from a different machine -- and every file in it went through the entire
// pipeline again. Re-read from disk, re-hashed, re-parsed for metadata, text
// extracted a second time, classified a second time, and handed a fresh
// rename proposal to review. On this repository that is the normal shape of
// an import, not an edge case: the second folder is mostly the first one plus
// a few hundred genuinely new files.
//
// The cost was paid three times over. Machine time re-parsing thousands of
// documents. Gemini calls, where the sibling check did not save them. And
// worst, a review queue of thousands of proposals and duplicate groups, every
// one of them about a document already dealt with -- which is exactly the
// pile that makes people stop reviewing anything at all.
//
// THE ARGUMENT FOR ADOPTING
//
// A SHA-256 match means the bytes are identical. Identical bytes cannot parse
// to different text, carry a different embedded title, or be a different
// document. So every stage downstream of hashing already knows its answer:
// it is whatever the twin got. Recomputing it is not more correct, only
// slower.
//
// WHAT IS DELIBERATELY NOT ADOPTED
//
//   The canonical (renamed) name. A byte-identical second copy does not need
//   its own naming decision -- it keeps its own filename and is filed under
//   the inherited subject, which is the same outcome the user already
//   accepts for a rejected proposal ("the original name is fine"). Copying
//   the name instead would put two shortcuts with the same name in the same
//   mirror folder, and generate a review item to confirm something already
//   confirmed.
//
//   Duplicate detection. The new file IS a duplicate and the group is the
//   honest record of that -- it is what the Duplicates page and the
//   reclaimable-bytes figure are built on. It stays.
const fileRepository = require("../repositories/fileRepository");
const fileContentRepository = require("../repositories/fileContentRepository");
const fileMetadataRepository = require("../repositories/fileMetadataRepository");
const classificationResultRepository = require("../repositories/classificationResultRepository");
const auditLogRepository = require("../repositories/auditLogRepository");

/** The pipeline stages an adoption makes unnecessary, for the audit record. */
const STAGES_SKIPPED = ["extract_metadata", "extract_text", "classify", "generate_names"];

/**
 * Copy everything an identical twin already established onto `file`.
 *
 * Returns a summary of what was adopted. Every step is individually
 * conditional: a twin that was extracted but never classified still saves the
 * extraction, and the new file simply has no classification to inherit --
 * which is the same state it would have reached on its own, just without the
 * work.
 *
 * @param {object} file - the newly-hashed file row
 * @param {object} twin - the row from fileRepository.findProcessedTwinByHash
 */
// WRITE ORDER IS DELIBERATE -- file_content goes LAST.
//
// These are six separate statements against five tables with no enclosing
// transaction, so a worker killed part-way through leaves the file in
// whatever partial state it had reached. What decides whether that is
// recoverable is which write landed first.
//
// fileRepository.listUnprocessed -- the rescan that rescues files the
// pipeline dropped -- looks for "has no hash, OR has no file_content row".
// So the file_content row is, in effect, this file's "I am done" marker.
// Writing it FIRST (as this did) meant a crash immediately afterwards left a
// file that looked finished to every recovery mechanism and had nothing else:
// no metadata, no classification, no subject, absent from the mirror, and
// never retried.
//
// Writing it LAST inverts that. A crash anywhere before the end leaves no
// file_content row, the next scan sees an unprocessed file, and it goes
// through the ordinary pipeline. The partial writes it left behind are all
// either idempotent (copyFrom, updateAiEnrichment, setDocumentDate) or
// superseded by the real stage's own output. Costs one retry; cannot strand.
async function adoptFrom(file, twin) {
  const adopted = { content: false, metadata: false, documentDate: false, classification: false, aiEnrichment: false };

  const metadata = await fileMetadataRepository.copyFrom(twin.id, file.id);
  adopted.metadata = Boolean(metadata);

  // The document's own date was resolved from the file's contents (or, for
  // 'filesystem', from timestamps that are about the copy rather than the
  // document -- in which case this file's own timestamps are no better a
  // guess, so inheriting loses nothing).
  if (twin.document_date) {
    await fileRepository.setDocumentDate(file.id, twin.document_date, twin.document_date_source);
    adopted.documentDate = true;
  }

  // Where the twin ended up filed. Recorded as a new classification_results
  // row rather than a pointer, because "latest row wins" is how every read of
  // a file's subject works (listBySubject, the mirror, the Subjects tree) --
  // a file with no row of its own would show as unfiled everywhere.
  const twinClassifications = await classificationResultRepository.listProposedForFile(twin.id);
  const latest = twinClassifications[0] || null;
  if (latest && (latest.classified_subject_id || latest.classified_document_type_id)) {
    await classificationResultRepository.create({
      fileId: file.id,
      classifiedSubjectId: latest.classified_subject_id,
      classifiedDocumentTypeId: latest.classified_document_type_id,
      confidenceLevel: latest.confidence_level,
      confidenceScore: latest.confidence_score,
      method: latest.method,
      rawOutput: {
        adoptedFromFileId: twin.id,
        reason:
          "Byte-identical to an already-classified file (same SHA-256); reused its classification " +
          "instead of running the classifier again.",
      },
    });
    adopted.classification = true;
  }

  // The denormalized AI fields the listings render. Copied so the duplicate
  // does not appear in the UI as an unprocessed blank next to its twin.
  if (twin.ai_classified_at) {
    await fileRepository.updateAiEnrichment(file.id, {
      shortTitle: twin.ai_short_title,
      summary: twin.ai_summary,
      entities: twin.ai_entities,
    });
    adopted.aiEnrichment = true;
  }

  // Last, for the reason set out above this function: this row is what marks
  // the file "processed" to listUnprocessed, so nothing may precede it that a
  // crash would leave unfinished.
  const content = await fileContentRepository.copyFrom(twin.id, file.id);
  adopted.content = Boolean(content);

  // Loud in the audit log on purpose. "Why was this file never extracted?" is
  // a question someone will ask, and the answer has to be findable rather
  // than inferred from an absence of jobs.
  await auditLogRepository.record({
    action: "file.adopted_known_content",
    entityType: "file",
    entityId: file.id,
    newState: { twinFileId: twin.id, sha256Hash: file.sha256_hash, adopted, stagesSkipped: STAGES_SKIPPED },
    reason:
      `Byte-identical (SHA-256) to "${twin.filename_current}", which has already been through the ` +
      `pipeline. Reused its extracted text, metadata and classification instead of re-running ` +
      `${STAGES_SKIPPED.join(", ")}. Duplicate detection still runs, so this copy is recorded as a ` +
      "duplicate; it keeps its own filename and no rename proposal was created for it.",
  });

  return { twinFileId: twin.id, adopted, stagesSkipped: STAGES_SKIPPED };
}

module.exports = { adoptFrom, STAGES_SKIPPED };
