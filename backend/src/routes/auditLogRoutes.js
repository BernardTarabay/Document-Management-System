const express = require("express");
const controller = require("../controllers/auditLogController");
const { authenticate } = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/requirePermission");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();
router.use(authenticate, requirePermission("audit.view"));

router.get("/", asyncHandler(controller.list));
router.get("/export", asyncHandler(controller.exportCsv));
router.delete("/", requirePermission("audit.manage"), asyncHandler(controller.clear));

module.exports = router;
