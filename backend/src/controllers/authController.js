const authService = require("../services/authService");
const { validateRegisterInput, validateLoginInput, validateRefreshInput } = require("../validators/authValidators");

function context(req) {
  return { ipAddress: req.ip, userAgent: req.headers["user-agent"] };
}

async function register(req, res) {
  const input = validateRegisterInput(req.body);
  const result = await authService.register(input, context(req));
  res.status(201).json(result);
}

async function login(req, res) {
  const input = validateLoginInput(req.body);
  const result = await authService.login(input, context(req));
  res.json(result);
}

async function refresh(req, res) {
  const { refreshToken } = validateRefreshInput(req.body);
  const result = await authService.refresh(refreshToken, context(req));
  res.json(result);
}

async function logout(req, res) {
  const { refreshToken } = validateRefreshInput(req.body);
  await authService.logout(refreshToken);
  res.status(204).send();
}

async function me(req, res) {
  const session = await authService.getSession(req.user.id);
  res.json(session);
}

module.exports = { register, login, refresh, logout, me };
