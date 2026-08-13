const express = require("express");
const controller = require("../controllers/documentController");
const { authenticate } = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/requirePermission");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();
router.use(authenticate);

router.get("/", requirePermission("document.view"), asyncHandler(controller.list));
router.get("/:id", requirePermission("document.view"), asyncHandler(controller.getOne));
router.patch("/:id", requirePermission("classification.modify"), asyncHandler(controller.update));

module.exports = router;
