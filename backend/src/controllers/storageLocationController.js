const storageLocationService = require("../services/storageLocationService");
const filesystemBrowseService = require("../services/filesystemBrowseService");

async function list(req, res) {
  res.json(await storageLocationService.list());
}

async function getOne(req, res) {
  res.json(await storageLocationService.getById(req.params.id));
}

async function create(req, res) {
  const location = await storageLocationService.create(req.body, req.user.id);
  res.status(201).json(location);
}

async function scan(req, res) {
  const job = await storageLocationService.triggerScan(req.params.id, req.user.id);
  res.status(202).json(job);
}

async function remove(req, res) {
  res.json(await storageLocationService.remove(req.params.id, req.user.id));
}

async function browse(req, res) {
  res.json(await filesystemBrowseService.listDirectories(req.query.path));
}

/**
 * Toggle whether this app may rename/move the real files in a folder.
 * Turning it off is the consequential direction, so the service audits it
 * with the consequence spelled out.
 */
async function setReadOnly(req, res) {
  const { isReadOnly } = req.body || {};
  res.json(await storageLocationService.setReadOnly(req.params.id, Boolean(isReadOnly), req.user.id));
}

// uploadFile / finalizeUpload are gone -- see the note in
// routes/storageLocationRoutes.js. Folders are registered and indexed in
// place; nothing is copied into the project directory any more.

module.exports = { list, getOne, create, scan, remove, browse, setReadOnly };
