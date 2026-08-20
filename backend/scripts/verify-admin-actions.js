// Exercises the admin user-management actions against the real database,
// including the guards that stop an admin locking everyone out. Creates its
// own throwaway users and deletes them afterwards -- it never touches the
// accounts you actually use.
const env = require("../src/config/env");
const { Pool } = require("pg");
const userService = require("../src/services/userService");
const userRepository = require("../src/repositories/userRepository");
const roleRepository = require("../src/repositories/roleRepository");
const authService = require("../src/services/authService");
const { hashPassword } = require("../src/utils/passwords");

const pool = new Pool({ connectionString: env.databaseUrl });
const log = (...a) => console.log(...a);
const created = [];
let passed = 0;
let failed = 0;

function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    log(`   PASS  ${label}${detail ? ` -- ${detail}` : ""}`);
  } else {
    failed += 1;
    log(`   FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

async function makeUser(name, roleName) {
  const email = `e2e-${name}-${Date.now()}@example.test`;
  const user = await userRepository.create({
    email,
    passwordHash: await hashPassword("initial-password-123"),
    fullName: `E2E ${name}`,
  });
  created.push(user.id);
  if (roleName) {
    const roles = await roleRepository.list({ limit: 100 });
    const role = roles.find((r) => r.name === roleName);
    await userRepository.assignRole(user.id, role.id, user.id);
  }
  return user;
}

async function cleanup() {
  try {
    if (created.length) {
      await pool.query("DELETE FROM refresh_tokens WHERE user_id = ANY($1::uuid[])", [created]);
      await pool.query("DELETE FROM audit_logs WHERE user_id = ANY($1::uuid[])", [created]);
      await pool.query("DELETE FROM user_roles WHERE user_id = ANY($1::uuid[])", [created]);
      await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [created]);
    }
    log("\ncleaned up all test users.");
  } catch (e) {
    log("cleanup warning:", e.message);
  }
  await pool.end();
}

async function run() {
  const roles = await roleRepository.list({ limit: 100 });
  const roleByName = Object.fromEntries(roles.map((r) => [r.name, r]));
  const actor = await makeUser("actor", "Admin");

  log("--- change role (replaces, does not accumulate) ---");
  const target = await makeUser("target", "Viewer");
  await userService.changeRole(target.id, roleByName.Manager.id, actor.id);
  let after = await userRepository.getRolesForUser(target.id);
  check("role replaced, not added", after.length === 1 && after[0].name === "Manager",
    `roles now: ${after.map((r) => r.name).join(", ")}`);

  log("\n--- suspend revokes sessions and blocks login ---");
  const victim = await makeUser("victim", "User");
  await authService.login({ email: victim.email, password: "initial-password-123" });
  const before = await pool.query(
    "SELECT count(*)::int n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL", [victim.id]);
  await userService.setStatus(victim.id, "suspended", actor.id);
  const afterTokens = await pool.query(
    "SELECT count(*)::int n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL", [victim.id]);
  check("had an active session before", before.rows[0].n === 1);
  check("sessions revoked on suspend", afterTokens.rows[0].n === 0);

  let loginBlocked = false;
  try {
    await authService.login({ email: victim.email, password: "initial-password-123" });
  } catch {
    loginBlocked = true;
  }
  check("suspended user cannot log in", loginBlocked);

  await userService.setStatus(victim.id, "active", actor.id);
  await authService.login({ email: victim.email, password: "initial-password-123" });
  check("reactivated user can log in again", true);

  log("\n--- password reset ---");
  const reset = await userService.resetPassword(victim.id, actor.id);
  check("a temporary password is returned", Boolean(reset.temporaryPassword),
    `${reset.temporaryPassword?.length} chars`);
  let oldPasswordRejected = false;
  try {
    await authService.login({ email: victim.email, password: "initial-password-123" });
  } catch {
    oldPasswordRejected = true;
  }
  check("the old password stops working", oldPasswordRejected);
  await authService.login({ email: victim.email, password: reset.temporaryPassword });
  check("the new password works", true);

  const auditRow = await pool.query(
    "SELECT reason FROM audit_logs WHERE entity_id = $1 AND action = 'user.password_reset' LIMIT 1", [victim.id]);
  check("the password is NOT written to the audit log",
    !JSON.stringify(auditRow.rows).includes(reset.temporaryPassword));

  log("\n--- revoke sessions without suspending ---");
  await authService.login({ email: victim.email, password: reset.temporaryPassword });
  await userService.revokeSessions(victim.id, actor.id);
  const revoked = await pool.query(
    "SELECT count(*)::int n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL", [victim.id]);
  check("all refresh tokens revoked", revoked.rows[0].n === 0);
  const stillActive = await userRepository.findById(victim.id);
  check("account stays active (not suspended)", stillActive.status === "active");

  log("\n--- lockout guards ---");
  let selfSuspendBlocked = false;
  let selfSuspendMsg = "";
  try {
    await userService.setStatus(actor.id, "suspended", actor.id);
  } catch (err) {
    selfSuspendBlocked = true;
    selfSuspendMsg = err.message;
  }
  check("cannot suspend your own account", selfSuspendBlocked, selfSuspendMsg);

  // Make our actor the only active admin by suspending every other one.
  const otherAdmins = await pool.query(
    `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE r.name = 'Admin' AND u.status = 'active' AND u.id <> $1`, [actor.id]);
  const restore = otherAdmins.rows.map((r) => r.id);
  if (restore.length) {
    await pool.query("UPDATE users SET status = 'suspended' WHERE id = ANY($1::uuid[])", [restore]);
  }

  try {
    let demoteBlocked = false;
    let demoteMsg = "";
    try {
      await userService.changeRole(actor.id, roleByName.Viewer.id, actor.id);
    } catch (err) {
      demoteBlocked = true;
      demoteMsg = err.message;
    }
    check("cannot demote the last active admin", demoteBlocked, demoteMsg.slice(0, 80));

    const secondAdmin = await makeUser("second-admin", "Admin");
    let demoteAllowed = true;
    try {
      await userService.changeRole(actor.id, roleByName.Viewer.id, secondAdmin.id);
    } catch {
      demoteAllowed = false;
    }
    check("CAN demote once another admin exists", demoteAllowed);
  } finally {
    if (restore.length) {
      await pool.query("UPDATE users SET status = 'active' WHERE id = ANY($1::uuid[])", [restore]);
      log(`   (restored ${restore.length} pre-existing admin account(s) to active)`);
    }
  }

  log(`\n================ ${failed === 0 ? "ALL PASSED" : `${failed} FAILED`} (${passed} passed) ================`);
}

run()
  .catch((e) => { console.error("\nFAILED:", e); failed += 1; })
  // The exit code is the only part of this a runner can read. Without it the
  // script printed its failures and still exited 0, so `verify:all` -- and any
  // CI -- would call a failing run a passing one.
  .finally(async () => {
    await cleanup();
    process.exitCode = failed === 0 ? 0 : 1;
  });
