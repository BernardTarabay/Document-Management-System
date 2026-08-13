// Verifies the JWT access token and attaches req.user = {id, email, roles,
// permissions}. Authorization decisions (RBAC) are made in
// requirePermission.js, not here -- this middleware only establishes
// identity. Per spec §19/§20: "Authentication and authorization must be
// implemented server-side" -- this is enforced on every protected route
// regardless of what the frontend hides.
const { verifyAccessToken } = require("../utils/jwt");
const userRepository = require("../repositories/userRepository");

async function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "Missing or malformed Authorization header." });
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired access token." });
  }

  const user = await userRepository.findById(payload.sub);
  if (!user || user.status !== "active") {
    return res.status(401).json({ error: "Account no longer active." });
  }

  const permissions = await userRepository.getPermissionsForUser(user.id);
  req.user = { id: user.id, email: user.email, permissions };
  next();
}

module.exports = { authenticate };
