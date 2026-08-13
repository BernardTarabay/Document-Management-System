const express = require("express");
const controller = require("../controllers/userController");
const { authenticate } = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/requirePermission");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();
router.use(authenticate, requirePermission("user.manage"));

router.get("/", asyncHandler(controller.listRoles));

module.exports = router;
