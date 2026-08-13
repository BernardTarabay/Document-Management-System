const express = require("express");
const controller = require("../controllers/userController");
const { authenticate } = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/requirePermission");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();
router.use(authenticate, requirePermission("user.manage"));

router.get("/", asyncHandler(controller.list));
router.get("/:id", asyncHandler(controller.getOne));

// Role changes are gated on role.manage in addition to user.manage: granting
// a role is how permissions are granted, so it is a strictly stronger action
// than editing a user.
router.post("/:id/roles", requirePermission("role.manage"), asyncHandler(controller.assignRole));
router.patch("/:id/role", requirePermission("role.manage"), asyncHandler(controller.changeRole));

router.patch("/:id/status", asyncHandler(controller.setStatus));
router.post("/:id/revoke-sessions", asyncHandler(controller.revokeSessions));
router.post("/:id/reset-password", asyncHandler(controller.resetPassword));

module.exports = router;
