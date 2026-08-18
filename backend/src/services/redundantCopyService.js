// Deleting the copies you provably do not need.
//
// WHAT MAKES THIS DIFFERENT FROM EVERYTHING ELSE HERE
//
// Atlas does not hold your documents. A download streams from the original file
// where it lies, and the organized folder is shortcuts pointing at it. So
// "delete the original once it is safely in Atlas" is, in general, data loss:
// there is no second copy, and completing the pipeline never produced one.
//
// There is exactly one case where deleting an original loses nothing, and this
// service is that case and only that case: a file whose EXACT bytes also exist
// somewhere else Atlas has indexed, in a duplicate group the user has already
// resolved. Delete the non-canonical copy and the document is still on disk,
// still indexed, still downloadable -- through the copy that was kept.
//
// THE SAFETY ARGUMENT IS "THE OTHER COPY IS STILL THERE", SO THAT IS CHECKED
//
// Not assumed from the database. Before a single file is removed, the canonical
// is opened and re-hashed, and if it is missing, unreadable, or its bytes no
// longer match what was recorded, nothing is deleted. A stale row claiming a
// twin exists is precisely how this feature would quietly destroy the last copy
// of something, so the row is never the evidence -- the file is.
//
// Every other guard here exists for a failure someone could plausibly hit:
//
//   read-only locations       a location marked read-only is one the user said
//                             not to write to; deleting from it is the largest
//                             possible write
//   last copy of a hash       belt and braces on top of the canonical check --
//                             if only one file in the whole repository has
//                             these bytes, it is not redundant by definition
//   same-path collision       canonical and copy resolving to the same file on
//                             disk means deleting the "copy" deletes the
//                             canonical
//   two-step confirmation     the caller types the phrase; see the controller
const path = require("path");
const db = require("../config/database");
const fileRepository = require("../repositories/fileRepository");
const storageLocationRepository = require("../repositories/storageLocationRepository");
const auditLogRepository = require("../repositories/auditLogRepository");
const { getStorageServiceFor } = require("./storage/storageService");
const { sha256Stream } = require("./hashingService");
const { requireOwner } = require("../repositories/ownership");
const { ValidationError } = require("../validators/validationError");

/**
 * Every copy that is safe to delete, with the file that will survive it.
 *
 * Read-only by construction -- this is what a dry run shows, and what the
 * confirmation is written against.
 */
async function listRedundant(ownerUserId, { limit = 1000 } = {}) {
  requireOwner(ownerUserId, "redundantCopyService.listRedundant");

  const { rows } = await db.query(
    `SELECT
       copy.id             AS copy_id,
       copy.current_path   AS copy_path,
       copy.filename_current AS copy_name,
       copy.size_bytes     AS size_bytes,
       copy.sha256_hash    AS sha256_hash,
       copy.storage_location_id AS copy_location_id,
       cl.name             AS copy_location,
       cl.is_read_only     AS copy_location_read_only,
       keep.id             AS canonical_id,
       keep.current_path   AS canonical_path,
       keep.storage_location_id AS canonical_location_id,
       kl.name             AS canonical_location,
       dg.id               AS group_id
     FROM duplicate_groups dg
     JOIN duplicate_group_members dgm ON dgm.duplicate_group_id = dg.id
     JOIN files copy ON copy.id = dgm.file_id
     JOIN files keep ON keep.id = dg.canonical_file_id
     JOIN storage_locations cl ON cl.id = copy.storage_location_id
     JOIN storage_locations kl ON kl.id = keep.storage_location_id
    WHERE dg.owner_user_id = $1
      AND dg.canonical_file_id IS NOT NULL
      AND copy.id <> dg.canonical_file_id
      AND copy.status = 'active'
      AND keep.status = 'active'
      -- Only EXACT groups. A near-duplicate is a different document that
      -- happens to be similar, and deleting one because it resembles another
      -- is not what "redundant" means.
      AND dg.group_type = 'exact'
      AND copy.sha256_hash IS NOT NULL
      AND copy.sha256_hash = keep.sha256_hash
    ORDER BY copy.size_bytes DESC
    LIMIT $2`,
    [ownerUserId, limit]
  );

  const deletable = [];
  const blocked = [];
  for (const row of rows) {
    if (row.copy_location_read_only) {
      blocked.push({ ...row, reason: `"${row.copy_location}" is marked read-only.` });
    } else if (
      row.copy_location_id === row.canonical_location_id &&
      path.resolve(row.copy_path) === path.resolve(row.canonical_path)
    ) {
      blocked.push({ ...row, reason: "The copy and the kept file are the same file on disk." });
    } else {
      deletable.push(row);
    }
  }

  const bytes = deletable.reduce((sum, r) => sum + Number(r.size_bytes || 0), 0);
  return { deletable, blocked, reclaimableBytes: bytes };
}

/**
 * Re-read the file that is going to survive, and confirm it really is intact.
 *
 * This is the whole safety argument, so it is evidence rather than trust: a row
 * saying a twin exists is exactly the thing that would be wrong in the case
 * that matters. Returns the failure reason instead of throwing, so one bad
 * canonical blocks its own copy and not the whole run.
 */
async function verifyCanonical(row, cache) {
  const cached = cache.get(row.canonical_id);
  if (cached) return cached;

  let result;
  try {
    let location = cache.get(`loc:${row.canonical_location_id}`);
    if (!location) {
      location = await storageLocationRepository.findById(row.canonical_location_id);
      cache.set(`loc:${row.canonical_location_id}`, location);
    }
    if (!location) {
      result = { ok: false, reason: "the kept file's storage location no longer exists" };
    } else {
      const storageService = getStorageServiceFor(location);
      const actual = await sha256Stream(storageService.readStream(row.canonical_path));
      result = actual === row.sha256_hash
        ? { ok: true }
        : { ok: false, reason: "the kept file's contents have changed since it was indexed" };
    }
  } catch (err) {
    result = { ok: false, reason: `the kept file could not be read (${err.message})` };
  }

  cache.set(row.canonical_id, result);
  return result;
}

/**
 * Delete the redundant copies, for real.
 *
 * @param {string[]|null} fileIds - specific copies, or null for everything
 *   `listRedundant` offers.
 *
 * Order matters and is deliberate: verify the survivor, then delete the file
 * from disk, then remove the row. Removing the row first would leave an
 * orphaned file that nothing knows about; deleting the file before verifying
 * the survivor is the mistake this whole service exists to avoid.
 */
async function deleteRedundant(ownerUserId, { fileIds = null } = {}) {
  requireOwner(ownerUserId, "redundantCopyService.deleteRedundant");

  const { deletable } = await listRedundant(ownerUserId, { limit: 5000 });
  const wanted = fileIds
    ? deletable.filter((r) => fileIds.includes(r.copy_id))
    : deletable;

  if (wanted.length === 0) {
    throw new ValidationError("Nothing to delete -- no resolved duplicate has a redundant copy on disk.");
  }

  const result = { deleted: 0, bytesFreed: 0, skipped: [], files: [] };
  const cache = new Map();

  for (const row of wanted) {
    // 1. The survivor has to be real, readable, and unchanged.
    const check = await verifyCanonical(row, cache);
    if (!check.ok) {
      result.skipped.push({ fileId: row.copy_id, path: row.copy_path, reason: check.reason });
      continue;
    }

    // 2. Belt and braces: never remove the last file carrying these bytes.
    const { rows: [{ n }] } = await db.query(
      `SELECT count(*)::int AS n FROM files
        WHERE owner_user_id = $1 AND sha256_hash = $2 AND status = 'active'`,
      [ownerUserId, row.sha256_hash]
    );
    if (n < 2) {
      result.skipped.push({
        fileId: row.copy_id, path: row.copy_path,
        reason: "this is the only remaining file with these contents",
      });
      continue;
    }

    try {
      const location = await storageLocationRepository.findById(row.copy_location_id);
      const storageService = getStorageServiceFor(location);

      // 3. Written BEFORE the delete: once the file and the row are gone this
      //    entry is the only record that the copy ever existed, and where.
      await auditLogRepository.record({
        userId: ownerUserId,
        action: "file.redundant_copy_deleted",
        entityType: "file",
        entityId: row.copy_id,
        previousState: {
          path: row.copy_path,
          location: row.copy_location,
          sizeBytes: Number(row.size_bytes),
          sha256: row.sha256_hash,
        },
        newState: { keptFileId: row.canonical_id, keptPath: row.canonical_path, keptLocation: row.canonical_location },
        reason:
          `Deleted a redundant copy from disk. The identical file at "${row.canonical_path}" ` +
          `in "${row.canonical_location}" was re-read and verified byte-for-byte before this was removed.`,
      });

      await storageService.remove(row.copy_path);

      // 4. The row goes too. Leaving it would claim a file exists at a path
      //    where there is nothing; marking it deleted would put it in the
      //    Trash, which promises a restore that cannot happen.
      await db.query("DELETE FROM files WHERE id = $1 AND owner_user_id = $2", [row.copy_id, ownerUserId]);

      result.deleted += 1;
      result.bytesFreed += Number(row.size_bytes || 0);
      result.files.push({ path: row.copy_path, location: row.copy_location });
    } catch (err) {
      result.skipped.push({ fileId: row.copy_id, path: row.copy_path, reason: err.message });
    }
  }

  return result;
}

module.exports = { listRedundant, deleteRedundant, verifyCanonical };
