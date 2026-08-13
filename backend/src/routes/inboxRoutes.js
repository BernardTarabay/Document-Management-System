const express = require("express");
const controller = require("../controllers/inboxController");
const { authenticate } = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/requirePermission");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();
router.use(authenticate, requirePermission("email.manage"));

// Query: status ('kept' default, or 'deleted' for the "what did auto-triage
// remove" transparency view), limit, offset.
router.get("/", asyncHandler(controller.list));

module.exports = router;
