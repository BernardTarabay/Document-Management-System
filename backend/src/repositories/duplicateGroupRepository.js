// Safe deduplication (see docs/01-domain-model.md §1.3, spec §13).
const db = require("../config/database");
const { createBaseRepository } = require("./baseRepository");

const base = createBaseRepository("duplicate_groups");

async function createGroup({ groupType, detectionMethod, confidenceLevel = null, confidenceScore = null }) {
  const { rows } = await db.query(
    `INSERT INTO duplicate_groups (group_type, detection_method, confidence_level, confidence_score)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [groupType, detectionMethod, confidenceLevel, confidenceScore]
  );
  return rows[0];
}

/**
 * The EXACT group for a content hash, creating it only if nobody else has.
 *
 * Replaces a find-then-create in detectDuplicatesProcessor that two
 * concurrently-hashing copies of the same file could both win, producing two
 * open groups for one set of bytes (see migration 027). ON CONFLICT makes the
 * database the arbiter: whoever inserts second gets the first one's row back
 * instead of a second group or a 23505.
 *
 * DO UPDATE rather than DO NOTHING because DO NOTHING returns no row on
 * conflict, which is precisely the case that needs the existing group.
 * Assigning content_key to itself is the cheapest no-op that still RETURNs.
 */
async function findOrCreateExactGroup({ contentKey, detectionMethod, confidenceLevel, confidenceScore }) {
  const { rows } = await db.query(
    `INSERT INTO duplicate_groups (group_type, detection_method, confidence_level, confidence_score, content_key)
     VALUES ('exact', $1, $2, $3, $4)
     ON CONFLICT (content_key) WHERE group_type = 'exact' AND content_key IS NOT NULL
       DO UPDATE SET content_key = EXCLUDED.content_key
     RETURNING *`,
    [detectionMethod, confidenceLevel, confidenceScore, contentKey]
  );
  return rows[0];
}

async function addMember(duplicateGroupId, fileId, similarityScore = null) {
  const { rows } = await db.query(
    `INSERT INTO duplicate_group_members (duplicate_group_id, file_id, similarity_score)
     VALUES ($1,$2,$3)
     ON CONFLICT (duplicate_group_id, file_id) DO NOTHING
     RETURNING *`,
    [duplicateGroupId, fileId, similarityScore]
  );
  return rows[0] || null;
}

/**
 * The members of a group, with enough about each copy to actually choose
 * between them.
 *
 * This used to return the filename, the path and the hash. That is enough to
 * LIST the copies and not nearly enough to pick one, which is the only
 * decision this page exists to support -- and for an exact group it is the
 * hardest version of that decision, because the bytes are identical so
 * nothing about the content can break the tie. What breaks it is everything
 * around the file: which drive it is on, whether that location is read-only,
 * whether this copy is the one that got indexed and named, whether it is a
 * cloud placeholder that is not really here at all.
 *
 * So each member now carries its size and type, its location, its readability
 * (a copy whose text never extracted is a worse thing to keep than one that
 * did), where it is filed, and whether it is already the canonical pick.
 * All of it is one row per member -- the alternative was the page issuing a
 * GET /files/:id per copy just to render a list.
 */
async function listMembers(duplicateGroupId) {
  const { rows } = await db.query(
    `SELECT dgm.*,
            f.filename_current, f.filename_original, f.canonical_filename,
            f.current_path, f.sha256_hash, f.size_bytes, f.extension, f.status,
            f.imported_at, f.modified_at_fs, f.is_cloud_placeholder,
            f.document_date, f.document_date_source,
            f.ai_short_title, f.ai_summary,
            sl.name         AS location_name,
            sl.is_read_only AS location_is_read_only,
            fc.text_quality,
            fc.needs_ocr,
            length(fc.extracted_text) AS text_length,
            cls.subject_name,
            -- IS NOT NULL first, or an unresolved group yields NULL rather
            -- than false for every member and the flag is three-valued.
            (dg.canonical_file_id IS NOT NULL AND dg.canonical_file_id = dgm.file_id) AS is_canonical
       FROM duplicate_group_members dgm
       JOIN duplicate_groups dg ON dg.id = dgm.duplicate_group_id
       JOIN files f ON f.id = dgm.file_id
       JOIN storage_locations sl ON sl.id = f.storage_location_id
       LEFT JOIN file_content fc ON fc.file_id = f.id
       LEFT JOIN LATERAL (
         SELECT s.name AS subject_name
           FROM classification_results cr
           JOIN subjects s ON s.id = cr.classified_subject_id
          WHERE cr.file_id = f.id AND cr.classified_subject_id IS NOT NULL
          ORDER BY cr.created_at DESC LIMIT 1
       ) cls ON true
      WHERE dgm.duplicate_group_id = $1
      ORDER BY dgm.added_at ASC`,
    [duplicateGroupId]
  );
  return rows;
}

/** Never deletes files -- only records which one is treated as canonical. */
async function setCanonicalFile(duplicateGroupId, fileId, resolvedBy) {
  const { rows } = await db.query(
    `UPDATE duplicate_groups
     SET canonical_file_id = $2, status = 'resolved', resolved_by = $3, resolved_at = now()
     WHERE id = $1 RETURNING *`,
    [duplicateGroupId, fileId, resolvedBy]
  );
  return rows[0] || null;
}

/**
 * @param {object} [opts]
 * @param {string|null} [opts.groupType] - restrict to 'exact' or 'probable';
 *   null lists both. The auto-resolve job MUST pass 'exact': probable groups
 *   are suggestions that require a human to confirm (docs/01-domain-model.md
 *   §1.3), so sweeping them into an automated resolve would be exactly the
 *   thing that section forbids.
 */
async function listOpen({ limit = 50, offset = 0, groupType = null } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM duplicate_groups
     WHERE status = 'open' AND ($3::duplicate_group_type IS NULL OR group_type = $3)
     ORDER BY created_at ASC LIMIT $1 OFFSET $2`,
    [limit, offset, groupType]
  );
  return rows;
}

/** Cheap count for progress totals (auto-resolve-all job sizing). */
async function countOpen(groupType = null) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS count FROM duplicate_groups
     WHERE status = 'open' AND ($1::duplicate_group_type IS NULL OR group_type = $1)`,
    [groupType]
  );
  return rows[0].count;
}

async function findGroupContainingFile(fileId) {
  const { rows } = await db.query(
    `SELECT dg.* FROM duplicate_groups dg
     JOIN duplicate_group_members dgm ON dgm.duplicate_group_id = dg.id
     WHERE dgm.file_id = $1`,
    [fileId]
  );
  return rows;
}

module.exports = {
  ...base, createGroup, findOrCreateExactGroup, addMember, listMembers,
  setCanonicalFile, listOpen, countOpen, findGroupContainingFile,
};
