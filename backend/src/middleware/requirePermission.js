// RBAC enforcement (spec §20). The frontend may hide a button, but this is
// what actually stops the request -- every route that changes or exposes
// non-public data goes through this after authenticate().
function requirePermission(permissionKey) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required." });
    }
    if (!req.user.permissions.includes(permissionKey)) {
      return res.status(403).json({
        error: `Missing required permission: ${permissionKey}`,
      });
    }
    next();
  };
}

module.exports = { requirePermission };
