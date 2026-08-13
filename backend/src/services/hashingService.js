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

module.exports = { sha256Stream };
