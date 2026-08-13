// JWT issuance/verification (spec §19: "JWT handling should include
// appropriate expiration and token lifecycle management"). Access tokens are
// short-lived and stateless; refresh tokens are additionally tracked in the
// `refresh_tokens` table (see repositories/refreshTokenRepository.js) so
// they can be revoked/rotated server-side -- a bare JWT can't be revoked,
// which is exactly why refresh tokens are NOT just longer-lived JWTs trusted
// on their own.
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const env = require("../config/env");

function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email },
    env.jwt.accessSecret,
    { expiresIn: env.jwt.accessExpiresIn }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, env.jwt.accessSecret);
}

/**
 * Refresh tokens are opaque random strings, not JWTs -- the client holds the
 * raw value, the DB holds only its SHA-256 hash (refresh_tokens.token_hash),
 * so a leaked database dump doesn't hand out usable refresh tokens.
 */
function generateRefreshTokenValue() {
  return crypto.randomBytes(48).toString("hex");
}

function hashRefreshToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

function refreshTokenExpiryDate() {
  const ms = parseDurationToMs(env.jwt.refreshExpiresIn);
  return new Date(Date.now() + ms);
}

function parseDurationToMs(duration) {
  const match = String(duration).match(/^(\d+)([smhd])$/);
  if (!match) return 7 * 24 * 3600 * 1000; // fallback: 7 days
  const value = parseInt(match[1], 10);
  const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]];
  return value * unit;
}

/**
 * Short-lived, single-purpose JWT carried through the OAuth redirect round
 * trip (email account connect flow) so the callback knows which app user
 * and which provider initiated it -- Google/Microsoft's `state` param is
 * designed for exactly this ("opaque value your app can use to maintain
 * state"), and a signed JWT means no extra DB table/row just to remember
 * one pending connect attempt for a few minutes.
 */
function signOAuthState({ userId, provider }) {
  return jwt.sign({ userId, provider }, env.jwt.accessSecret, { expiresIn: "10m" });
}

function verifyOAuthState(state) {
  return jwt.verify(state, env.jwt.accessSecret); // { userId, provider, iat, exp }
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  generateRefreshTokenValue,
  hashRefreshToken,
  refreshTokenExpiryDate,
  signOAuthState,
  verifyOAuthState,
};
