// These tests protect a real standing credential: email_accounts
// .refresh_token_encrypted grants read+trash access to someone's actual
// mailbox. Set the key BEFORE requiring anything -- config/env.js reads
// process.env at require time, and dotenv does not override vars that are
// already set, so this keeps the suite hermetic rather than dependent on
// whatever happens to be in the developer's .env.
process.env.TOKEN_ENCRYPTION_KEY = "test-key-not-the-real-one";

const test = require("node:test");
const assert = require("node:assert");

const { encrypt, decrypt } = require("../src/utils/tokenCrypto");

const SAMPLE = "1//0gLm-refresh-token-sample_value";

test("encrypt/decrypt round-trips", () => {
  assert.strictEqual(decrypt(encrypt(SAMPLE)), SAMPLE);
});

test("ciphertext is iv:authTag:data and contains no plaintext", () => {
  const enc = encrypt(SAMPLE);
  const parts = enc.split(":");
  assert.strictEqual(parts.length, 3);
  assert.strictEqual(parts[0].length, 24, "12-byte IV as hex");
  assert.strictEqual(parts[1].length, 32, "16-byte GCM auth tag as hex");
  assert.ok(parts.every((p) => /^[0-9a-f]+$/.test(p)), "all parts hex-encoded");
  assert.ok(!enc.includes(SAMPLE));
});

test("the same plaintext encrypts differently each time (random IV)", () => {
  // A deterministic ciphertext would leak that two accounts share a token
  // and would be catastrophic for GCM specifically (nonce reuse).
  const a = encrypt(SAMPLE);
  const b = encrypt(SAMPLE);
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a.split(":")[0], b.split(":")[0], "IVs must differ");
  assert.strictEqual(decrypt(a), decrypt(b));
});

test("tampering with the ciphertext is rejected by the auth tag", () => {
  const parts = encrypt(SAMPLE).split(":");
  const flipped = parts[2][0] === "0" ? "1" : "0";
  parts[2] = flipped + parts[2].slice(1);
  assert.throws(() => decrypt(parts.join(":")));
});

test("tampering with the auth tag is rejected", () => {
  const parts = encrypt(SAMPLE).split(":");
  parts[1] = "0".repeat(32);
  assert.throws(() => decrypt(parts.join(":")));
});

test("a ciphertext from a different key does not decrypt", () => {
  const enc = encrypt(SAMPLE);
  // Re-require the module under a different key by clearing the cache.
  delete require.cache[require.resolve("../src/utils/tokenCrypto")];
  delete require.cache[require.resolve("../src/config/env")];
  process.env.TOKEN_ENCRYPTION_KEY = "a-completely-different-key";
  const other = require("../src/utils/tokenCrypto");
  assert.throws(() => other.decrypt(enc));
  process.env.TOKEN_ENCRYPTION_KEY = "test-key-not-the-real-one";
});

test("malformed payloads throw a clear error rather than crashing oddly", () => {
  for (const bad of ["", null, undefined, "notevenclose", "only:two"]) {
    assert.throws(() => decrypt(bad), /Malformed encrypted token payload/);
  }
});

test("round-trips unicode and long values", () => {
  const unicode = "refresh-اختبار-מבחן-测试-\u{1F510}";
  assert.strictEqual(decrypt(encrypt(unicode)), unicode);
  const long = "x".repeat(8000);
  assert.strictEqual(decrypt(encrypt(long)), long);
});

test("missing TOKEN_ENCRYPTION_KEY fails loudly instead of using a default key", () => {
  // A defaulted key would mean every uninitialized install shares one --
  // config/env.js deliberately leaves this undefined.
  delete require.cache[require.resolve("../src/utils/tokenCrypto")];
  delete require.cache[require.resolve("../src/config/env")];
  const saved = process.env.TOKEN_ENCRYPTION_KEY;
  // Set to empty rather than deleting: config/env.js calls dotenv.config(),
  // which repopulates any var *absent* from process.env from the real .env
  // file. An empty string is still "present", so it survives, and is falsy.
  process.env.TOKEN_ENCRYPTION_KEY = "";
  const unset = require("../src/utils/tokenCrypto");
  assert.throws(() => unset.encrypt("x"), /TOKEN_ENCRYPTION_KEY is not set/);
  process.env.TOKEN_ENCRYPTION_KEY = saved;
});
