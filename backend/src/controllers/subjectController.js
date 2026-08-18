const subjectService = require("../services/subjectService");

async function list(req, res) {
  res.json(await subjectService.list(req.query, req.user.id));
}

async function countDocumentsForSubject(req, res) {
  res.json(await subjectService.countDocumentsForSubject(req.params.id, req.query, req.user.id));
}

async function documentsForSubject(req, res) {
  res.json(await subjectService.getDocumentsForSubject(req.params.id, req.query, req.user.id));
}

/** Folders this user filed into most recently -- the picker's shortlist. */
async function recentDestinations(req, res) {
  res.json(await subjectService.listRecentDestinations(req.user.id));
}

/**
 * `origin` is deliberately NOT taken from the request body.
 *
 * It records who decided a folder should exist, and the whole point of
 * recording that is to distinguish a human's structure from a model's
 * suggestion. A client that could set it could label its own creations as
 * anything, which makes the badge meaningless. Folders created here are
 * 'user' by definition -- a person clicked the button. The assistant's
 * accepted suggestions go through triageService, which passes 'ai' from
 * server-side context.
 */
async function create(req, res) {
  const { parentId, name, description } = req.body || {};
  const subject = await subjectService.create(
    { parentId, name, description, origin: "user" },
    req.user.id
  );
  res.status(201).json(subject);
}

async function update(req, res) {
  const { name, description } = req.body || {};
  res.json(await subjectService.update(req.params.id, { name, description }, req.user.id));
}

/**
 * What deleting this folder would take with it, so the confirmation can name
 * the consequences instead of asking "are you sure?" about an unknown amount.
 */
/**
 * Move a folder under a different parent. Separate from PATCH /:id, which is
 * rename/describe only -- reparenting rewrites the whole branch's paths and is
 * a structurally different operation.
 */
async function moveToParent(req, res) {
  const { parentId } = req.body || {};
  res.json(await subjectService.moveToParent(req.params.id, parentId || null, req.user.id));
}

async function removalPreview(req, res) {
  res.json(await subjectService.previewRemoval(req.params.id, req.user.id));
}

/**
 * `?force=true` is the user having seen the preview and said yes. Without it
 * a folder holding documents or subfolders is refused with a message naming
 * both -- confirmation, not prohibition.
 */
async function remove(req, res) {
  res.json(
    await subjectService.remove(req.params.id, req.user.id, {
      force: String(req.query.force || "").toLowerCase() === "true",
      // "unfile" (default) or "trash". The documents are never destroyed by a
      // folder delete -- the worst it does is put them somewhere recoverable.
      contents: String(req.query.contents || "unfile").toLowerCase() === "trash" ? "trash" : "unfile",
    })
  );
}

// importFile is gone along with folderImportService -- it copied file bytes
// into the managed upload folder. See routes/storageLocationRoutes.js.

module.exports = {
  list, documentsForSubject, countDocumentsForSubject, recentDestinations,
  create, update, remove, removalPreview, moveToParent,
};
