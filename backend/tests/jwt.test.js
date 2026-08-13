// Hermetic secrets -- set before requiring config/env (dotenv does not
// override already-present vars), so these never depend on the real .env.
process.env.JWT_ACCESS_SECRET = "test-access-secret";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret";

const test = require("node:test");
const assert = require("node:assert");
const jwtLib = require("jsonwebtoken");

const {
  signAccessToken,
  verifyAccessToken,
  generateRefreshTokenValue,
  hashRefreshToken,
  refreshTokenExpiryDate,
  signOAuthState,
  verifyOAuthState,
} = require("../src/utils/jwt");

const USER = { id: "11111111-1111-1111-1111-111111111111", email: "a@example.org" };

test("access token round-trips subject and email", () => {
  const decoded = verifyAccessToken(signAccessToken(USER));
  assert.strictEqual(decoded.sub, USER.id);
  assert.strictEqual(decoded.email, USER.email);
  assert.ok(decoded.exp > decoded.iat, "must carry an expiry");
});

test("access token carries no password or permission data", () => {
  // A JWT payload is base64, not encrypted -- anything put in it is public.
  const decoded = verifyAccessToken(signAccessToken({ ...USER, passwordHash: "$2b$12$secret" }));
  assert.deepStrictEqual(Object.keys(decoded).sort(), ["email", "exp", "iat", "sub"]);
});

test("a token signed with the wrong secret is rejected", () => {
  const forged = jwtLib.sign({ sub: USER.id }, "not-the-real-secret");
  assert.throws(() => verifyAccessToken(forged), /invalid signature/);
});

test("an expired access token is rejected", () => {
  const expired = jwtLib.sign({ sub: USER.id }, process.env.JWT_ACCESS_SECRET, { expiresIn: "-1s" });
  assert.throws(() => verifyAccessToken(expired), /jwt expired/);
});

test("an alg:none token is rejected", () => {
  // The classic JWT bypass: strip the signature and claim no algorithm.
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: USER.id })).toString("base64url");
  assert.throws(() => verifyAccessToken(`${header}.${payload}.`));
});

test("refresh token values are opaque, random, and stored only as a hash", () => {
  const a = generateRefreshTokenValue();
  const b = generateRefreshTokenValue();
  assert.strictEqual(a.length, 96, "48 random bytes as hex");
  assert.notStrictEqual(a, b);
  assert.strictEqual(a.split(".").length, 1, "not a JWT -- opaque by design");

  const hash = hashRefreshToken(a);
  assert.strictEqual(hash.length, 64, "sha256 hex");
  assert.notStrictEqual(hash, a, "the raw value must never equal what is stored");
  assert.strictEqual(hashRefreshToken(a), hash, "hashing is deterministic for lookup");
  assert.notStrictEqual(hashRefreshToken(b), hash);
});

test("refresh token expiry is in the future and honors the configured window", () => {
  const expiry = refreshTokenExpiryDate();
  assert.ok(expiry instanceof Date);
  assert.ok(expiry.getTime() > Date.now(), "must be in the future");
});

test("OAuth state round-trips userId and provider", () => {
  const decoded = verifyOAuthState(signOAuthState({ userId: USER.id, provider: "gmail" }));
  assert.strictEqual(decoded.userId, USER.id);
  assert.strictEqual(decoded.provider, "gmail");
});

test("OAuth state expires in 10 minutes", () => {
  // The window the connect flow has to complete; a long-lived state token
  // would be a replayable identity assertion.
  const decoded = verifyOAuthState(signOAuthState({ userId: USER.id, provider: "gmail" }));
  assert.strictEqual(decoded.exp - decoded.iat, 600);
});

test("a forged or expired OAuth state is rejected", () => {
  assert.throws(() => verifyOAuthState("garbage"));
  assert.throws(() => verifyOAuthState(jwtLib.sign({ userId: "x", provider: "gmail" }, "wrong-secret")));

  const stale = jwtLib.sign({ userId: USER.id, provider: "gmail" }, process.env.JWT_ACCESS_SECRET, { expiresIn: "-1s" });
  assert.throws(() => verifyOAuthState(stale), /jwt expired/);
});
