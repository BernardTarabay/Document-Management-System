const crypto = require("crypto");
const userRepository = require("../repositories/userRepository");
const roleRepository = require("../repositories/roleRepository");
const refreshTokenRepository = require("../repositories/refreshTokenRepository");
const auditLogRepository = require("../repositories/auditLogRepository");
const { hashPassword } = require("../utils/passwords");
const { parsePagination } = require("../utils/pagination");
const { ValidationError } = require("../validators/validationError");
const { UserStatus } = require("../models/enums");

const ADMIN_ROLE = "Admin";

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
    this.publicMessage = message;
  }
}

function publicUser(user) {
  const { password_hash, ...rest } = user; // eslint-disable-line no-unused-vars
  return rest;
}

async function list(query) {
  const { limit, offset } = parsePagination(query);
  const users = await userRepository.listWithRoles({ limit, offset });
  return users.map(publicUser);
}

async function getById(id) {
  const user = await userRepository.findById(id);
  if (!user) throw new NotFoundError("User not found.");
  const roles = await userRepository.getRolesForUser(id);
  return { ...publicUser(user), roles: roles.map((r) => ({ id: r.id, name: r.name })) };
}

async function requireUser(id) {
  const user = await userRepository.findById(id);
  if (!user) throw new NotFoundError("User not found.");
  return user;
}

/**
 * Refuse any change that would leave the system with no way back in.
 *
 * There is no recovery path in the app for "nobody is an admin any more" --
 * the README's own instructions for granting the first Admin are a raw SQL
 * INSERT against the database, which is precisely what an operator locked
 * out of the UI cannot easily reach. So demoting or suspending the final
 * active admin is refused rather than merely warned about.
 */
async function assertNotLastAdmin(targetUserId, action) {
  const roles = await userRepository.getRolesForUser(targetUserId);
  const isAdmin = roles.some((r) => r.name === ADMIN_ROLE);
  if (!isAdmin) return;

  const othersRemaining = await userRepository.countActiveUsersWithRole(ADMIN_ROLE, targetUserId);
  if (othersRemaining === 0) {
    throw new ValidationError(
      `This is the only active ${ADMIN_ROLE}. ${action} would leave nobody able to administer the ` +
      "system, and there is no way to grant the role back from inside the app."
    );
  }
}

async function assignRole(userId, roleId, actorUserId) {
  await requireUser(userId);
  const role = await roleRepository.findById(roleId);
  if (!role) throw new ValidationError("Role not found.");

  await userRepository.assignRole(userId, roleId, actorUserId);

  await auditLogRepository.record({
    userId: actorUserId,
    action: "permission.changed",
    entityType: "user",
    entityId: userId,
    newState: { roleAssigned: role.name },
    reason: `Role "${role.name}" granted`,
  });

  return getById(userId);
}

/**
 * Replace a user's roles with exactly one. This is what the Users page's
 * role dropdown does -- "change role", not "add another role".
 */
async function changeRole(userId, roleId, actorUserId) {
  await requireUser(userId);
  const role = await roleRepository.findById(roleId);
  if (!role) throw new ValidationError("Role not found.");

  const previousRoles = await userRepository.getRolesForUser(userId);
  if (role.name !== ADMIN_ROLE) {
    await assertNotLastAdmin(userId, `Changing their role to "${role.name}"`);
  }

  await userRepository.setSoleRole(userId, roleId, actorUserId);

  await auditLogRepository.record({
    userId: actorUserId,
    action: "permission.changed",
    entityType: "user",
    entityId: userId,
    previousState: { roles: previousRoles.map((r) => r.name) },
    newState: { roles: [role.name] },
    reason: `Role changed to "${role.name}"`,
  });

  return getById(userId);
}

/**
 * Suspend or reactivate.
 *
 * Suspension takes effect immediately, including for tokens already issued:
 * middleware/authenticate.js re-reads the user and rejects any status other
 * than 'active' on every single request, and authService.login/refresh
 * check it too. Refresh tokens are revoked as well so there is nothing left
 * to resume from if the account is later reactivated.
 */
async function setStatus(userId, status, actorUserId) {
  const allowed = [UserStatus.ACTIVE, UserStatus.SUSPENDED];
  if (!allowed.includes(status)) {
    throw new ValidationError(`status must be one of: ${allowed.join(", ")}.`);
  }

  const user = await requireUser(userId);
  if (status === UserStatus.SUSPENDED) {
    if (userId === actorUserId) {
      throw new ValidationError("You cannot suspend your own account.");
    }
    await assertNotLastAdmin(userId, "Suspending them");
  }

  const updated = await userRepository.setStatus(userId, status);
  if (status === UserStatus.SUSPENDED) {
    await refreshTokenRepository.revokeAllForUser(userId);
  }

  await auditLogRepository.record({
    userId: actorUserId,
    action: status === UserStatus.SUSPENDED ? "user.suspended" : "user.reactivated",
    entityType: "user",
    entityId: userId,
    previousState: { status: user.status },
    newState: { status },
    reason:
      status === UserStatus.SUSPENDED
        ? "Suspended from the Users page; active sessions revoked"
        : "Reactivated from the Users page",
  });

  return publicUser(updated);
}

/**
 * Force sign-out everywhere by revoking every refresh token.
 *
 * Unlike suspension, this does NOT change the account's status, so an
 * access token already issued keeps working until it expires (15 minutes by
 * default) -- it is a stateless JWT and cannot be recalled. That window is
 * stated plainly in the response rather than papered over: an admin dealing
 * with a lost laptop needs to know this is "signed out within 15 minutes",
 * not "signed out now". Suspending the account instead is immediate.
 */
async function revokeSessions(userId, actorUserId) {
  await requireUser(userId);
  await refreshTokenRepository.revokeAllForUser(userId);

  await auditLogRepository.record({
    userId: actorUserId,
    action: "user.sessions_revoked",
    entityType: "user",
    entityId: userId,
    reason: "All refresh tokens revoked from the Users page",
  });

  return {
    success: true,
    note:
      "Refresh tokens revoked. Any access token already issued remains valid until it expires " +
      "(15 minutes by default) -- a stateless JWT cannot be recalled.",
  };
}

/**
 * Refuse an action against a user who holds a role the actor cannot grant.
 *
 * WHY THIS EXISTS
 *
 * routes/userRoutes.js states the rule the whole file is built on: "granting a
 * role is how permissions are granted, so it is a strictly stronger action
 * than editing a user" -- which is why POST /:id/roles and PATCH /:id/role
 * require role.manage on top of user.manage.
 *
 * Resetting a password quietly went around that. It is gated on user.manage
 * alone AND accepts a caller-CHOSEN password, so a principal holding
 * user.manage without role.manage could set an Admin's password to a value
 * they picked and sign in as that Admin -- acquiring role.manage, audit.manage
 * and everything else without ever touching a role. Same for suspending an
 * Admin or cutting their sessions.
 *
 * The shipped seed does not hand out that combination (Manager is denied
 * user.manage precisely so it cannot reach this router), so this was latent
 * rather than live. But the permission model deliberately separates the two
 * keys, so the moment anyone defines a role that holds one and not the other,
 * the escalation is real. The guard belongs here, next to the action, not in
 * the seed.
 */
async function assertMayActOnUser(targetUserId, actorUserId, action) {
  if (targetUserId === actorUserId) return; // acting on yourself grants nothing new

  const [targetRoles, actorPermissions] = await Promise.all([
    userRepository.getRolesForUser(targetUserId),
    userRepository.getPermissionsForUser(actorUserId),
  ]);

  const targetIsPrivileged = targetRoles.some((r) => r.name === ADMIN_ROLE);
  if (targetIsPrivileged && !actorPermissions.includes("role.manage")) {
    throw new ValidationError(
      `${action} an ${ADMIN_ROLE} requires the role.manage permission -- otherwise it would be a way ` +
      "to take over an administrator account without ever being allowed to grant a role."
    );
  }
}

/**
 * Admin-set temporary password.
 *
 * Existing passwords are bcrypt hashes and cannot be read back, so there is
 * no "show me their password" -- only replacement. The new password is
 * returned once to the admin so they can pass it on, and every session is
 * revoked so the old credential stops working immediately.
 */
async function resetPassword(userId, actorUserId, explicitPassword = null) {
  await requireUser(userId);
  await assertMayActOnUser(userId, actorUserId, "Resetting the password of");

  if (explicitPassword !== null && String(explicitPassword).length < 12) {
    throw new ValidationError("A password must be at least 12 characters.");
  }
  if (explicitPassword !== null && Buffer.byteLength(String(explicitPassword), "utf8") > 72) {
    // bcrypt hashes at most 72 bytes and silently ignores the rest, so a
    // longer password would be accepted here and then be equivalent to its
    // own 72-byte prefix at login. Say so rather than pretending.
    throw new ValidationError("A password must be at most 72 bytes.");
  }

  // 24 hex chars from 12 random bytes -- comfortably above the minimum and
  // easy to read out over the phone.
  const temporaryPassword = explicitPassword || crypto.randomBytes(12).toString("hex");
  await userRepository.setPasswordHash(userId, await hashPassword(temporaryPassword));
  await refreshTokenRepository.revokeAllForUser(userId);

  await auditLogRepository.record({
    userId: actorUserId,
    action: "user.password_reset",
    entityType: "user",
    entityId: userId,
    // The password itself is deliberately NOT recorded here -- an audit log
    // is readable by anyone with audit.view.
    reason: "Password reset by an administrator; active sessions revoked",
  });

  return {
    success: true,
    temporaryPassword,
    warning: "Shown once. Give it to the user and have them change it after signing in.",
  };
}

module.exports = {
  NotFoundError,
  list,
  getById,
  assignRole,
  changeRole,
  setStatus,
  revokeSessions,
  resetPassword,
};
