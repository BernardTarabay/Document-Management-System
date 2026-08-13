const subjectService = require("../services/subjectService");

async function list(req, res) {
  res.json(await subjectService.list(req.query));
}

async function documentsForSubject(req, res) {
  res.json(await subjectService.getDocumentsForSubject(req.params.id, req.query));
}

async function create(req, res) {
  const { parentId, name, description } = req.body || {};
  const subject = await subjectService.create({ parentId, name, description }, req.user.id);
  res.status(201).json(subject);
}

async function update(req, res) {
  const { name, description } = req.body || {};
  res.json(await subjectService.update(req.params.id, { name, description }, req.user.id));
}

async function remove(req, res) {
  res.json(await subjectService.remove(req.params.id, req.user.id));
}

// importFile is gone along with folderImportService -- it copied file bytes
// into the managed upload folder. See routes/storageLocationRoutes.js.

module.exports = { list, documentsForSubject, create, update, remove };
