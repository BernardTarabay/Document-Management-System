const storageLocationService = require("../services/storageLocationService");
const filesystemBrowseService = require("../services/filesystemBrowseService");

// Every handler passes req.user.id down. The service treats it as required
// and throws if it is missing, so a handler that forgets fails loudly on the
// first request rather than quietly serving another account's folders.

async function list(req, res) {
  res.json(await storageLocationService.list(req.user.id));
}

async function getOne(req, res) {
  res.json(await storageLocationService.getById(req.params.id, req.user.id));
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
 * Name and behaviour flags. Fields are picked out explicitly rather than
 * forwarding req.body: a pass-through would let a caller set owner_user_id or
 * root_path, and "which account owns this folder" is not a client's decision
 * to make.
 */
async function update(req, res) {
  const { name, isReadOnly, watchEnabled, autoApplyNaming, replicationEnabled } = req.body || {};
  res.json(
    await storageLocationService.update(
      req.params.id,
      { name, isReadOnly, watchEnabled, autoApplyNaming, replicationEnabled },
      req.user.id
    )
  );
}

/**
 * Toggle whether this app may rename/move the real files in a folder.
 * Turning it off is the consequential direction, so the service audits it
 * with the consequence spelled out. Kept as its own route because that is
 * what the existing UI calls.
 */
async function setReadOnly(req, res) {
  const { isReadOnly } = req.body || {};
  res.json(await storageLocationService.setReadOnly(req.params.id, Boolean(isReadOnly), req.user.id));
}

// uploadFile / finalizeUpload are gone -- see the note in
// routes/storageLocationRoutes.js. Folders are registered and indexed in
// place; nothing is copied into the project directory any more.

module.exports = { list, getOne, create, update, scan, remove, browse, setReadOnly };
