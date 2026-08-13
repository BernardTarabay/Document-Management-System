const userService = require("../services/userService");
const roleRepository = require("../repositories/roleRepository");
const { ValidationError } = require("../validators/validationError");

async function list(req, res) {
  res.json(await userService.list(req.query));
}

async function getOne(req, res) {
  res.json(await userService.getById(req.params.id));
}

async function assignRole(req, res) {
  const { roleId } = req.body || {};
  if (!roleId) throw new ValidationError("roleId is required.");
  res.json(await userService.assignRole(req.params.id, roleId, req.user.id));
}

/** Replace the user's roles with exactly one -- the Users page dropdown. */
async function changeRole(req, res) {
  const { roleId } = req.body || {};
  if (!roleId) throw new ValidationError("roleId is required.");
  res.json(await userService.changeRole(req.params.id, roleId, req.user.id));
}

async function setStatus(req, res) {
  const { status } = req.body || {};
  if (!status) throw new ValidationError("status is required.");
  res.json(await userService.setStatus(req.params.id, status, req.user.id));
}

async function revokeSessions(req, res) {
  res.json(await userService.revokeSessions(req.params.id, req.user.id));
}

async function resetPassword(req, res) {
  // An admin may supply a password, or omit it to have one generated.
  const { password = null } = req.body || {};
  res.json(await userService.resetPassword(req.params.id, req.user.id, password));
}

async function listRoles(req, res) {
  res.json(await roleRepository.list({ limit: 100 }));
}

module.exports = {
  list, getOne, assignRole, changeRole, setStatus, revokeSessions, resetPassword, listRoles,
};
