const express = require("express");
const controller = require("../controllers/storageLocationController");
const { authenticate } = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/requirePermission");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();
router.use(authenticate);

// The byte-upload routes ("/upload", "/upload/finalize") are gone, along
// with multer.
//
// They existed so a user could drag a folder onto the app instead of typing
// an absolute path -- but a browser cannot hand back a real filesystem
// path, so the implementation COPIED every file into
// backend/storage/uploads. That silently duplicated the user's data inside
// the project directory, and re-dragging the same folder produced a second
// set of rows (the "40 files became 80" report).
//
// The intent behind drag-and-drop -- "let me point at a folder without
// typing its path" -- is served properly by GET /browse, a server-side
// folder picker (FolderBrowserModal.jsx). Registering a folder indexes it
// where it is and copies nothing.

// Reads are gated on document.view rather than left at bare authentication:
// a storage location row is an absolute path on the owner's disk, which is
// not something every signed-in account should be handed by default.
router.get("/", requirePermission("document.view"), asyncHandler(controller.list));
router.get("/browse", requirePermission("user.manage"), asyncHandler(controller.browse));
router.get("/:id", requirePermission("document.view"), asyncHandler(controller.getOne));
router.post("/", requirePermission("user.manage"), asyncHandler(controller.create));
router.post("/:id/scan", requirePermission("scan.run"), asyncHandler(controller.scan));
// Whether this app may rename/move the real files in a folder. Same
// permission bar as registering one, since it is the same trust decision.
router.patch("/:id/read-only", requirePermission("user.manage"), asyncHandler(controller.setReadOnly));
router.delete("/:id", requirePermission("user.manage"), asyncHandler(controller.remove));

module.exports = router;
