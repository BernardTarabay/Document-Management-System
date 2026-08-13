const express = require("express");
const controller = require("../controllers/aiChatController");
const { authenticate } = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/requirePermission");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();
// classification.modify, not subject.manage -- chatting itself never writes
// anything (see geminiChatService.js), but every action it can propose is
// either a reclassification (move_file/move_subject_contents) or a
// taxonomy edit, so the bar to even ask for proposals matches the bar to
// act on them manually elsewhere in the app.
router.use(authenticate, requirePermission("classification.modify"));

router.post("/chat", asyncHandler(controller.chat));

module.exports = router;
