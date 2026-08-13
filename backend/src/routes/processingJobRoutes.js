const express = require("express");
const controller = require("../controllers/processingJobController");
const { authenticate } = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/requirePermission");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();
router.use(authenticate);

// Gated on document.view like every other read in the app. These were the two
// routes in the API that asked only "are you signed in?" -- and a job row
// carries its payload, which includes file ids and storage location ids, plus
// error messages naming real paths on disk. That is repository information,
// so it sits at the same bar as viewing the repository.
router.get("/", requirePermission("document.view"), asyncHandler(controller.list));
router.get("/:id", requirePermission("document.view"), asyncHandler(controller.getOne));

module.exports = router;
