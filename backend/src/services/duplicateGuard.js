// The check that runs before any file is filed into the Subjects tree.
//
// THE INVARIANT
//
// No duplicate document enters the organized tree silently. Not from a manual
// move, not from an AI-assisted one, not from a bulk action, not from the
// automatic classifier. That is only achievable if there is exactly ONE
// function that files a document (fileOrganizeService.moveToSubject) and it
// calls this one; a second "fast path" for bulk that skipped the check would
// make the invariant a wish.
//
// WHAT IT DISTINGUISHES, AND WHY THE DISTINCTION MATTERS
//
//   exact      byte-identical (same sha256). Provable, not a judgement.
//   version    same document, updated content -- same filename stem and a
//              high text similarity, or an explicit user statement that these
//              are revisions of one another
//   similar    high text similarity but not obviously a revision
//   distinct   related subject matter, legitimately different documents
//
// Collapsing these is the failure the requirement calls out. Two months of
// the same bank statement template share most of their text and are NOT
// duplicates; treating them as such teaches the user to dismiss the warning,
// after which the warning that mattered is dismissed too. So `similar` is
// reported with its score and its reason, and nothing is ever resolved
// automatically.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
// It does not block. It returns findings, and the caller decides -- because
// "keep both" is a legitimate and common answer, and a guard that cannot be
// overruled becomes a guard that gets routed around.
const fileRepository = require("../repositories/fileRepository");
const fileContentRepository = require("../repositories/fileContentRepository");
const duplicateGroupRepository = require("../repositories/duplicateGroupRepository");
const db = require("../config/database");
const similarity = require("./similarityService");
const { requireOwner } = require("../repositories/ownership");

const Finding = Object.freeze({
  EXACT: "exact",
  VERSION: "version",
  SIMILAR: "similar",
});

/**
 * Filename stems that suggest two files are revisions rather than copies.
 *
 * Deliberately conservative: it only fires when the stems match after
 * stripping an obvious version marker, so "Contract v1"/"Contract v2" and
 * "Invoice (final)"/"Invoice" pair up, while "Invoice January"/"Invoice
 * February" do not. A false "version" reading is worse than none -- it
 * invites the user to supersede a document that was never superseded.
 */
const VERSION_MARKERS =
  /[ _-]*(?:\(|\[)?(?:v|ver|version|rev|revision|draft|final|copy|copie|nouvelle?|new|old|ancien(?:ne)?)[ _-]*\d*(?:\)|\])?$/i;

function normalizeStem(filename) {
  const stem = String(filename || "").replace(/\.[^.]+$/, "");
  let previous;
  let current = stem;
  // Repeated because real names stack markers: "Contract v2 (final) copy".
  do {
    previous = current;
    current = current.replace(VERSION_MARKERS, "").trim();
  } while (current !== previous && current.length > 0);
  return current.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Pairs the user has already judged, so the same warning is not raised twice.
 *
 * A guard that repeats a question already answered is noise, and noise is
 * what trains people to click through the warning that mattered.
 */
async function dismissedPairs(fileId, candidateIds, ownerUserId) {
  if (!candidateIds.length) return new Set();
  const { rows } = await db.query(
    `SELECT file_id_a, file_id_b FROM duplicate_dismissals
      WHERE owner_user_id = $3
        AND ((file_id_a = $1 AND file_id_b = ANY($2::uuid[]))
          OR (file_id_b = $1 AND file_id_a = ANY($2::uuid[])))`,
    [fileId, candidateIds, ownerUserId]
  );
  return new Set(rows.map((r) => (r.file_id_a === fileId ? r.file_id_b : r.file_id_a)));
}

/**
 * Where a file currently sits in the tree, as a readable path.
 *
 * The whole value of the warning is in this string: "a very similar document
 * already exists" is not actionable, "...in Finance / Taxes / 2025" is.
 */
async function locate(fileIds, ownerUserId) {
  if (!fileIds.length) return {};
  const { rows } = await db.query(
    `SELECT f.id,
            f.filename_current,
            f.canonical_filename,
            f.size_bytes,
            f.document_date,
            f.imported_at,
            s.id   AS subject_id,
            s.name AS subject_name,
            s.materialized_path AS subject_path
       FROM files f
       LEFT JOIN LATERAL (
         SELECT cr.classified_subject_id
           FROM classification_results cr
          WHERE cr.file_id = f.id
          ORDER BY cr.created_at DESC LIMIT 1
       ) latest ON true
       LEFT JOIN subjects s ON s.id = latest.classified_subject_id
      WHERE f.id = ANY($1::uuid[]) AND f.owner_user_id = $2`,
    [fileIds, ownerUserId]
  );
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

/** "finance.taxes.2025" -> "Finance / Taxes / 2025", using real folder names. */
async function prettyPath(subjectPath, ownerUserId) {
  if (!subjectPath) return null;
  const { rows } = await db.query(
    `SELECT name FROM subjects
      WHERE owner_user_id = $2
        AND $1::text LIKE materialized_path || '%'
        AND (materialized_path = $1 OR $1::text LIKE materialized_path || '.%')
      ORDER BY depth ASC`,
    [subjectPath, ownerUserId]
  );
  return rows.length ? rows.map((r) => r.name).join(" / ") : null;
}

/**
 * Check one file against everything already filed.
 *
 * @param {string} fileId
 * @param {string} ownerUserId
 * @param {object} [opts]
 * @param {string} [opts.targetSubjectId] - where it is about to go. Findings
 *   in the SAME destination are the ones worth interrupting for; a similar
 *   document filed elsewhere is context, not a conflict.
 * @returns {Promise<{findings: Array, hasBlocking: boolean}>}
 */
async function check(fileId, ownerUserId, { targetSubjectId = null } = {}) {
  requireOwner(ownerUserId, "duplicateGuard.check");
  const file = await fileRepository.findByIdForOwner(fileId, ownerUserId);
  if (!file) return { findings: [], hasBlocking: false };

  const findings = [];

  // --- exact: provable, and the cheapest test ------------------------------
  const exactMatches = file.sha256_hash
    ? (await fileRepository.findBySha256(file.sha256_hash, ownerUserId))
        .filter((f) => f.id !== fileId && f.status !== "deleted")
    : [];

  // --- similar/version: only for files with enough text to judge -----------
  const content = await fileContentRepository.findByFile(fileId);
  const text = content?.extracted_text || "";
  let scored = [];
  if (similarity.hasEnoughTextToCompare(text)) {
    const candidates = await fileRepository.listSimilarityCandidates(file, { limit: 300 });
    scored = candidates
      .map((c) => ({ candidate: c, score: similarity.textSimilarity(text, c.extracted_text || "") }))
      .filter((r) => r.score >= similarity.PROBABLE_DUPLICATE_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  }

  const candidateIds = [...new Set([...exactMatches.map((f) => f.id), ...scored.map((r) => r.candidate.id)])];
  const [dismissed, located] = await Promise.all([
    dismissedPairs(fileId, candidateIds, ownerUserId),
    locate(candidateIds, ownerUserId),
  ]);

  const thisStem = normalizeStem(file.filename_current || file.filename_original);

  for (const match of exactMatches) {
    if (dismissed.has(match.id)) continue;
    const where = located[match.id];
    findings.push(await describeFinding({
      kind: Finding.EXACT,
      score: 1,
      existing: where || match,
      ownerUserId,
      targetSubjectId,
      why: "These two files are byte-for-byte identical -- their SHA-256 hashes match. This is not a judgement call.",
    }));
  }

  for (const { candidate, score } of scored) {
    if (dismissed.has(candidate.id)) continue;
    const where = located[candidate.id];
    const sameStem = thisStem && normalizeStem(candidate.filename_current) === thisStem;
    findings.push(await describeFinding({
      kind: sameStem ? Finding.VERSION : Finding.SIMILAR,
      score,
      existing: where || candidate,
      ownerUserId,
      targetSubjectId,
      why: sameStem
        ? `The names match once version markers are stripped, and the text is ${(score * 100).toFixed(0)}% alike -- ` +
          "this looks like a newer or older revision of the same document rather than a second copy."
        : `These share ${(score * 100).toFixed(0)}% of their five-word phrases, at or above the ` +
          `${(similarity.PROBABLE_DUPLICATE_THRESHOLD * 100).toFixed(0)}% threshold. Documents from the same ` +
          "template legitimately score this way, so this is a prompt to look, not a verdict.",
    }));
  }

  // "Blocking" means worth interrupting a move for: an exact copy anywhere,
  // or anything landing in the SAME folder the user is filing into. A similar
  // document in a different branch is reported but does not stop the flow --
  // it is usually the correct state of affairs.
  const hasBlocking = findings.some(
    (f) => f.kind === Finding.EXACT || (targetSubjectId && f.existing.subjectId === targetSubjectId)
  );

  return { findings, hasBlocking };
}

async function describeFinding({ kind, score, existing, ownerUserId, targetSubjectId, why }) {
  const path = await prettyPath(existing.subject_path, ownerUserId);
  const sameDestination = Boolean(targetSubjectId && existing.subject_id === targetSubjectId);
  return {
    kind,
    score: Number(score.toFixed(3)),
    why,
    sameDestination,
    existing: {
      id: existing.id,
      filename: existing.canonical_filename || existing.filename_current,
      subjectId: existing.subject_id || null,
      subjectName: existing.subject_name || null,
      subjectPath: path,
      sizeBytes: existing.size_bytes === null || existing.size_bytes === undefined
        ? null : Number(existing.size_bytes),
      documentDate: existing.document_date || null,
    },
    // What the UI should offer. Sent from here rather than decided in the
    // frontend so a new finding type cannot arrive with no way to act on it.
    actions: kind === Finding.EXACT
      ? ["view", "compare", "keep_both", "replace", "cancel"]
      : ["view", "compare", "keep_both", "mark_version", "cancel"],
    message: path
      ? `A ${kind === Finding.EXACT ? "byte-identical" : kind === Finding.VERSION ? "different version of this" : "very similar"} document already exists in ${path}.`
      : `A ${kind === Finding.EXACT ? "byte-identical" : "very similar"} document already exists, not yet filed.`,
  };
}

/**
 * Record that the user looked at a pair and decided they should both stay.
 *
 * Stored with the lower id first (a CHECK constraint enforces it) so (A,B)
 * and (B,A) are one row and one lookup.
 */
async function dismiss(fileIdA, fileIdB, ownerUserId, { relationship = "distinct", note = null } = {}) {
  requireOwner(ownerUserId, "duplicateGuard.dismiss");
  // Both sides must be the caller's, or this would let someone record a
  // judgement about a file they cannot see.
  const owned = await fileRepository.listByIdsForOwner([fileIdA, fileIdB], ownerUserId);
  if (owned.length !== 2) return null;

  const [a, b] = [fileIdA, fileIdB].sort();
  const { rows } = await db.query(
    `INSERT INTO duplicate_dismissals (owner_user_id, file_id_a, file_id_b, relationship, note, decided_by)
     VALUES ($1, $2, $3, $4, $5, $1)
     ON CONFLICT (file_id_a, file_id_b) DO UPDATE
       SET relationship = EXCLUDED.relationship, note = EXCLUDED.note
     RETURNING *`,
    [ownerUserId, a, b, relationship, note]
  );
  return rows[0];
}

module.exports = { Finding, check, dismiss, normalizeStem, MAX_FINDINGS: 10 };
