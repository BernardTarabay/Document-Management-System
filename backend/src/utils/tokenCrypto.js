// Encrypts OAuth refresh tokens (email_accounts.refresh_token_encrypted)
// at rest -- these are real, standing credentials that grant read/delete
// access to someone's actual mailbox, so they don't belong in the database
// as plaintext the way e.g. a bcrypt password hash is fine to store openly
// (a hash can't be used to log in; a refresh token can be used directly).
//
// AES-256-GCM: the key is always exactly 32 bytes because it's derived via
// SHA-256 of TOKEN_ENCRYPTION_KEY rather than requiring the operator to
// produce a precisely-formatted 32-byte value themselves -- any non-empty
// string in the env var works and always yields a valid key.
const crypto = require("crypto");
const env = require("../config/env");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit nonce, the GCM-recommended size

function getKey() {
  if (!env.tokenEncryptionKey) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not set -- required before any email account can be connected " +
      "(it encrypts the OAuth refresh token at rest)."
    );
  }
  return crypto.createHash("sha256").update(env.tokenEncryptionKey).digest();
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("hex"), authTag.toString("hex"), encrypted.toString("hex")].join(":");
}

function decrypt(payload) {
  const [ivHex, authTagHex, dataHex] = String(payload || "").split(":");
  if (!ivHex || !authTagHex || !dataHex) {
    throw new Error("Malformed encrypted token payload.");
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]);
  return decrypted.toString("utf8");
}

module.exports = { encrypt, decrypt };
