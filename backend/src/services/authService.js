// Business logic for authentication/session lifecycle (spec §19). Controllers
// stay thin -- this is where "what does registering/logging in actually
// mean" lives.
const userRepository = require("../repositories/userRepository");
const roleRepository = require("../repositories/roleRepository");
const refreshTokenRepository = require("../repositories/refreshTokenRepository");
const auditLogRepository = require("../repositories/auditLogRepository");
const { hashPassword, verifyPassword } = require("../utils/passwords");
const {
  signAccessToken,
  generateRefreshTokenValue,
  hashRefreshToken,
  refreshTokenExpiryDate,
} = require("../utils/jwt");

class AuthError extends Error {
  constructor(message, statusCode = 401) {
    super(message);
    this.statusCode = statusCode;
    this.publicMessage = message;
  }
}

async function issueTokenPair(user, { ipAddress, userAgent } = {}) {
  const accessToken = signAccessToken(user);
  const rawRefreshToken = generateRefreshTokenValue();

  // The stored row is returned so callers can link a rotation chain without
  // looking the token back up by its own hash -- which is what refresh() used
  // to do, an entirely avoidable second query on every single refresh.
  const stored = await refreshTokenRepository.create({
    userId: user.id,
    tokenHash: hashRefreshToken(rawRefreshToken),
    expiresAt: refreshTokenExpiryDate(),
    ipAddress,
    userAgent,
  });

  return { accessToken, refreshToken: rawRefreshToken, refreshTokenId: stored.id };
}

/**
 * Registration always assigns the low-privilege "User" role -- nothing
 * about self-registration is allowed to grant elevated access. Promoting
 * someone to Manager/Admin is a separate, permission-gated action
 * (see userService.js), not a registration-time choice.
 */
async function register({ email, password, fullName }, context = {}) {
  const existing = await userRepository.findByEmail(email);
  if (existing) throw new AuthError("An account with this email already exists.", 409);

  const passwordHash = await hashPassword(password);
  const user = await userRepository.create({ email, passwordHash, fullName });

  const defaultRole = await roleRepository.findByName("User");
  if (defaultRole) await userRepository.assignRole(user.id, defaultRole.id, null);

  await auditLogRepository.record({
    userId: user.id,
    action: "user.created",
    entityType: "user",
    entityId: user.id,
    newState: { email: user.email },
    reason: "Self-registration",
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const { refreshTokenId, ...tokens } = await issueTokenPair(user, context); // eslint-disable-line no-unused-vars
  return { user: publicUser(user), ...tokens };
}

async function login({ email, password }, context = {}) {
  const user = await userRepository.findByEmail(email);
  if (!user) throw new AuthError("Invalid email or password.");
  if (user.status !== "active") throw new AuthError("This account is not active.", 403);

  const validPassword = await verifyPassword(password, user.password_hash);
  if (!validPassword) throw new AuthError("Invalid email or password.");

  await userRepository.updateLastLogin(user.id);

  // Housekeeping on the rare event rather than the hot one: this table is
  // append-only otherwise and had grown to 98 rows on a single-user install.
  // Never allowed to fail a login -- a full token table is not a reason to
  // refuse someone entry.
  await refreshTokenRepository.pruneExpired().catch(() => {});

  const { refreshTokenId, ...tokens } = await issueTokenPair(user, context); // eslint-disable-line no-unused-vars

  await auditLogRepository.record({
    userId: user.id,
    action: "user.login",
    entityType: "user",
    entityId: user.id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return { user: publicUser(user), ...tokens };
}

/**
 * Rotate a refresh token: spend the presented one, issue a fresh pair.
 *
 * The claim is a single atomic UPDATE (refreshTokenRepository.claimValidByHash)
 * rather than a read followed by a revoke. Two things follow from that, and
 * both were missing before:
 *
 *   Exactly one caller can spend a given token. Concurrent requests carrying
 *   the same value used to BOTH succeed, turning one refresh token into two
 *   independent live sessions.
 *
 *   A second use is detectable. If the claim comes back empty but the token
 *   exists in the table, someone is presenting a value that was already
 *   spent. The legitimate holder cannot do that -- they hold whatever the
 *   rotation gave them -- so the honest reading is that this token leaked and
 *   two parties now hold it. The whole family is revoked and both are made to
 *   sign in again. That is the standard OAuth2 refresh-token-reuse response,
 *   and it is the only point in this design where a stolen token becomes
 *   visible rather than simply working forever.
 */
async function refresh(rawRefreshToken, context = {}) {
  const tokenHash = hashRefreshToken(rawRefreshToken);
  const stored = await refreshTokenRepository.claimValidByHash(tokenHash);

  if (!stored) {
    const known = await refreshTokenRepository.findAnyByHash(tokenHash);
    if (known && known.revoked_at) {
      await refreshTokenRepository.revokeAllForUser(known.user_id);
      await auditLogRepository.record({
        userId: known.user_id,
        action: "user.refresh_token_reuse",
        entityType: "user",
        entityId: known.user_id,
        newState: { refreshTokenId: known.id, revokedAt: known.revoked_at },
        reason:
          "A refresh token that had already been rotated was presented again. Every session for this " +
          "account was revoked as a precaution -- this is what a replayed (leaked) token looks like.",
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      });
      throw new AuthError("This session has been ended. Please sign in again.");
    }
    throw new AuthError("Refresh token is invalid or expired.");
  }

  const user = await userRepository.findById(stored.user_id);
  if (!user || user.status !== "active") throw new AuthError("Account is not active.", 403);

  const { refreshTokenId, ...tokens } = await issueTokenPair(user, context);
  await refreshTokenRepository.setReplacedBy(stored.id, refreshTokenId);

  return { user: publicUser(user), ...tokens };
}

async function logout(rawRefreshToken) {
  const tokenHash = hashRefreshToken(rawRefreshToken);
  const stored = await refreshTokenRepository.findValidByHash(tokenHash);
  if (stored) await refreshTokenRepository.revoke(stored.id);
}

async function getSession(userId) {
  const user = await userRepository.findById(userId);
  if (!user) throw new AuthError("User not found.", 404);
  const [roles, permissions] = await Promise.all([
    userRepository.getRolesForUser(userId),
    userRepository.getPermissionsForUser(userId),
  ]);
  return { ...publicUser(user), roles: roles.map((r) => r.name), permissions };
}

function publicUser(user) {
  const { password_hash, ...rest } = user; // eslint-disable-line no-unused-vars
  return rest;
}

module.exports = { AuthError, register, login, refresh, logout, getSession };
