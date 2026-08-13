const express = require("express");
const controller = require("../controllers/duplicateGroupController");
const { authenticate } = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/requirePermission");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();
router.use(authenticate, requirePermission("duplicate.manage"));

router.get("/", asyncHandler(controller.list));
router.post("/auto-resolve", asyncHandler(controller.autoResolveAll));
router.get("/:id", asyncHandler(controller.getOne));
router.post("/:id/resolve", asyncHandler(controller.resolve));

module.exports = router;
