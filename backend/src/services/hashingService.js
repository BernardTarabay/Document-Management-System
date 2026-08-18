// Streaming SHA-256 (spec §12: "must calculate a cryptographic hash such as
// SHA-256 for every relevant file"). Streams so multi-GB files never sit
// fully in memory just to be hashed.
const crypto = require("crypto");

/**
 * @param {import('stream').Readable} readStream
 * @returns {Promise<string>} lowercase hex sha256
 */
function sha256Stream(readStream) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    readStream.on("data", (chunk) => hash.update(chunk));
    readStream.on("error", reject);
    readStream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * The full sha256 AND the quick fingerprint, from ONE pass over the file.
 *
 * The fingerprint (see quickIdentityService) is what lets a LATER file be
 * recognised as this one's twin without being read. Computing it with separate
 * range reads would cost an extra 128 KB on top of a read that is already
 * touching every byte -- so it is derived from the same stream instead, and
 * costs nothing but the two buffers held.
 *
 * `tailStart` is `size - CHUNK`, which cannot overlap the head because callers
 * only fingerprint files of at least two chunks (below that the shortcut is not
 * used at all, so there is nothing to fingerprint for).
 *
 * @param {import('stream').Readable} readStream
 * @param {{ sizeBytes: number, chunkBytes: number, wantFingerprint: boolean }} opts
 * @returns {Promise<{ sha256: string, fingerprint: string|null }>}
 */
function sha256AndFingerprint(readStream, { sizeBytes, chunkBytes, wantFingerprint }) {
  return new Promise((resolve, reject) => {
    const size = Number(sizeBytes) || 0;
    const hash = crypto.createHash("sha256");
    const tailStart = size - chunkBytes;

    const headParts = [];
    const tailParts = [];
    let headLen = 0;
    let offset = 0;

    readStream.on("data", (chunk) => {
      hash.update(chunk);

      if (wantFingerprint) {
        if (headLen < chunkBytes) {
          const take = Math.min(chunkBytes - headLen, chunk.length);
          headParts.push(chunk.subarray(0, take));
          headLen += take;
        }
        const chunkEnd = offset + chunk.length;
        if (chunkEnd > tailStart) {
          const from = Math.max(0, tailStart - offset);
          tailParts.push(chunk.subarray(from));
        }
        offset = chunkEnd;
      }
    });

    readStream.on("error", reject);
    readStream.on("end", () => {
      let fingerprint = null;
      if (wantFingerprint) {
        const fp = crypto.createHash("sha256");
        fp.update(`size:${size}
`);
        fp.update(Buffer.concat(headParts));
        fp.update(Buffer.concat(tailParts));
        fingerprint = fp.digest("hex");
      }
      resolve({ sha256: hash.digest("hex"), fingerprint });
    });
  });
}

module.exports = { sha256Stream, sha256AndFingerprint };
