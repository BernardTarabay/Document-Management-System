const express = require("express");
const controller = require("../controllers/dashboardController");
const { authenticate } = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/requirePermission");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();
router.use(authenticate);

// Gated on document.view alone, which every role that can see the app has.
// The payload is counts, not records -- there is nothing here that a user
// permitted to see the Files page could not already total up by hand, so
// requiring duplicate.manage or audit.view would only produce a dashboard
// full of holes for ordinary users. Anything genuinely restricted (the audit
// trail itself) is still fetched separately by the page under its own
// permission.
router.get("/summary", requirePermission("document.view"), asyncHandler(controller.summary));

module.exports = router;
