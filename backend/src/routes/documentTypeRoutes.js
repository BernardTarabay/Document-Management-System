const express = require("express");
const controller = require("../controllers/documentTypeController");
const { authenticate } = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/requirePermission");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();
router.use(authenticate, requirePermission("document.view"));

router.get("/", asyncHandler(controller.list));
// Before "/" would shadow nothing here, but keep the specific route first as
// the other routers in this codebase do.
router.get("/browse", asyncHandler(controller.browse));

module.exports = router;
