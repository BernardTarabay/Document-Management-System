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

// PERMISSIONS
//
// These used to sit on `user.manage`, the permission for administering other
// people's ACCOUNTS. That was the bug behind "regular users cannot add
// storage locations": the `User` role quite correctly cannot administer
// users, and so could not register a folder either.
//
// Now that a location has an owner and every query here is scoped to it,
// registering, editing, scanning and removing YOUR OWN folder are ordinary
// user actions gated on `storage.manage`. They are not weaker than before --
// the service refuses to return, edit or scan a location belonging to anyone
// but the caller, so the blast radius of `storage.manage` is exactly one
// account's own folders.
router.get("/", requirePermission("document.view"), asyncHandler(controller.list));

// The server-side folder picker.
//
// This was gated on `user.manage` on the reasoning that enumerating the
// server's directories is a disclosure surface no per-user scope can narrow.
// The reasoning is right; the conclusion was wrong, because it left the
// PRIMARY "Add storage location" button 403ing for exactly the accounts that
// had just been granted permission to add one -- the picker is how you
// register a folder, so gating it above `storage.manage` gates registering.
//
// The disclosure is addressed where it actually lives instead:
// filesystemBrowseService now confines browsing to an explicit set of roots
// (BROWSE_ROOTS, defaulting to the backend account's home directory), checks
// containment before the stat so a refusal does not reveal existence, and
// filters symlinks that would lead out. Containment is what makes this safe
// to hand to an ordinary user; a permission never was.
router.get("/browse", requirePermission("storage.manage"), asyncHandler(controller.browse));

router.get("/:id", requirePermission("document.view"), asyncHandler(controller.getOne));
router.post("/", requirePermission("storage.manage"), asyncHandler(controller.create));
router.post("/:id/scan", requirePermission("scan.run"), asyncHandler(controller.scan));
// Name, read-only, watch, auto-apply and replication in one route. The old
// PATCH /:id/read-only is kept below as an alias so nothing that already
// calls it breaks.
router.patch("/:id", requirePermission("storage.manage"), asyncHandler(controller.update));
router.patch("/:id/read-only", requirePermission("storage.manage"), asyncHandler(controller.setReadOnly));
router.delete("/:id", requirePermission("storage.manage"), asyncHandler(controller.remove));

module.exports = router;
