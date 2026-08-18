// Recognising a file you already have, without reading it.
//
// WHERE THIS SITS
//
// knownContentService already makes an identical file's DOWNSTREAM work free:
// its text, metadata, date, classification and AI enrichment are adopted from
// the twin rather than recomputed. But that fires on the sha256, and reaching
// the sha256 means streaming every byte. On an import that is mostly
// overlapping copies -- the normal shape here -- the whole cost becomes reading
// hundreds of gigabytes to confirm something the filesystem already implied.
//
// This moves the recognition EARLIER, to before the file is opened in full.
//
//   1. Candidates, from the index alone: same owner, same exact byte size, same
//      exact mtime, already hashed. No file touched. Usually zero rows, and
//      then nothing here costs anything.
//   2. If there are candidates, read 64 KB from the front and 64 KB from the
//      back and fingerprint those with the size. 128 KB instead of 500 MB.
//   3. A fingerprint match means this is the twin's content, so the twin's
//      sha256 is adopted and the full read is skipped.
//
// WHY THIS IS ALLOWED TO BE AN INFERENCE
//
// Two different files can share a size, a head and a tail. It is vanishingly
// unlikely -- they would have to collide on 128 KB of content AND the exact
// byte length AND the exact modification time -- and it is not impossible.
//
// So the claim is recorded rather than hidden: `hash_source = 'inferred'`
// marks every sha256 that was believed instead of computed, which makes the
// set findable and repairable (scripts/verify-inferred-hashes.js). The
// alternative -- silently writing an unverified hash into the column that
// duplicate detection is built on -- is the version of this idea that would
// eventually corrupt something with no way to find out.
//
// WHAT IS DELIBERATELY EXCLUDED
//
//   Files <= 2 chunks. Reading them whole costs the same as fingerprinting
//   them, so they get a real hash and real certainty for free. The inference
//   only applies where it actually buys something.
//
//   Agent-backed locations. The range reads below are a local-filesystem
//   affordance; an agent reports its own results and does its own reading, and
//   inventing a remote range-read protocol to save I/O on someone else's disk
//   is not the same feature.
const crypto = require("crypto");
const db = require("../config/database");
const { requireOwner } = require("../repositories/ownership");

/** 64 KB from each end. Large enough that headers and trailers both land in it. */
const CHUNK_BYTES = 64 * 1024;

/** Below this, hashing the whole file is not meaningfully dearer than sampling it. */
const MIN_SIZE_FOR_INFERENCE = CHUNK_BYTES * 2;

/**
 * Files that could be this one, decided entirely from the index.
 *
 * Size and mtime together are what rsync's default quick-check trusts on its
 * own. Here they are only a candidate filter -- the fingerprint still has to
 * agree -- so a false candidate costs one 128 KB read, not a wrong answer.
 */
async function findCandidates(file) {
  requireOwner(file.owner_user_id, "quickIdentity.findCandidates");
  if (!file.modified_at_fs || !file.size_bytes) return [];

  const { rows } = await db.query(
    `SELECT id, sha256_hash, quick_fingerprint, size_bytes
       FROM files
      WHERE owner_user_id = $1
        AND size_bytes = $2
        AND modified_at_fs = $3
        AND sha256_hash IS NOT NULL
        AND id <> $4
        AND status <> 'deleted'
      LIMIT 8`,
    [file.owner_user_id, file.size_bytes, file.modified_at_fs, file.id]
  );
  return rows;
}

/** Read exactly one range, as a buffer. */
function readRange(storageService, targetPath, start, end) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = storageService.readStream(targetPath, { start, end });
    stream.on("data", (c) => chunks.push(c));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * sha256 over size + first chunk + last chunk.
 *
 * The size is mixed in so two files that happen to share a head and tail but
 * differ in length cannot collide, which is otherwise the easy case (a file and
 * the same file with something appended in the middle).
 */
async function fingerprint(storageService, targetPath, sizeBytes) {
  const size = Number(sizeBytes);
  const hash = crypto.createHash("sha256");
  hash.update(`size:${size}\n`);

  // Must match sha256AndFingerprint byte for byte, or a fingerprint sampled by
  // range read would never equal one derived from a full stream and the whole
  // mechanism would silently never match. Only files of at least two chunks are
  // fingerprinted, so head and tail cannot overlap.
  const head = await readRange(storageService, targetPath, 0, CHUNK_BYTES - 1);
  hash.update(head);

  const tail = await readRange(storageService, targetPath, size - CHUNK_BYTES, size - 1);
  hash.update(tail);

  return hash.digest("hex");
}

/**
 * The twin this file's content matches, found without reading it in full.
 *
 * @returns {Promise<{twin: object, fingerprint: string, candidatesChecked: number}|null>}
 *
 * null means "no shortcut" and the caller must hash normally -- which is the
 * answer for every genuinely new file, and costs one indexed lookup to reach.
 */
async function findTwinWithoutFullRead(file, storageService, { accessMode } = {}) {
  if (accessMode && accessMode !== "direct") return null;
  if (Number(file.size_bytes) < MIN_SIZE_FOR_INFERENCE) return null;

  const candidates = await findCandidates(file);
  if (candidates.length === 0) return null;

  const mine = await fingerprint(storageService, file.current_path, file.size_bytes);

  for (const candidate of candidates) {
    // A candidate that predates this feature has no fingerprint stored. It is
    // not a match we can make cheaply, and guessing from size and mtime alone
    // is exactly the weaker claim this service exists to avoid.
    if (!candidate.quick_fingerprint) continue;
    if (candidate.quick_fingerprint === mine) {
      return { twin: candidate, fingerprint: mine, candidatesChecked: candidates.length };
    }
  }

  // Fingerprint computed but nothing matched: hand it back so the caller can
  // store it after the full hash, rather than reading those 128 KB twice.
  return { twin: null, fingerprint: mine, candidatesChecked: candidates.length };
}

async function setFingerprint(fileId, value) {
  await db.query("UPDATE files SET quick_fingerprint = $2 WHERE id = $1", [fileId, value]);
}

async function setHashSource(fileId, source) {
  await db.query("UPDATE files SET hash_source = $2 WHERE id = $1", [fileId, source]);
}

module.exports = {
  CHUNK_BYTES,
  MIN_SIZE_FOR_INFERENCE,
  findCandidates,
  fingerprint,
  findTwinWithoutFullRead,
  setFingerprint,
  setHashSource,
};
