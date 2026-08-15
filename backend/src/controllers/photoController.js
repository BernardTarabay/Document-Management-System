const photoService = require("../services/photoService");

async function list(req, res) {
  res.json(await photoService.list(req.query, req.user.id));
}

async function summary(req, res) {
  res.json(await photoService.summary(req.user.id));
}

async function detail(req, res) {
  res.json(await photoService.detail(req.params.id, req.user.id));
}

async function runOcr(req, res) {
  const { force, languages } = req.body || {};
  res.status(202).json(
    await photoService.requestOcr(req.params.id, req.user.id, { force: Boolean(force), languages })
  );
}

async function runOcrForPending(req, res) {
  res.status(202).json(await photoService.requestOcrForPending(req.user.id));
}


/**
 * Bulk file. Answers 409 when the duplicate guard stopped one or more of
 * them -- the body carries which, and why, so the UI can walk the user
 * through rather than silently filing or silently dropping.
 */
async function moveMany(req, res) {
  const { fileIds, subjectId, confirmDuplicates } = req.body || {};
  const result = await photoService.moveMany(fileIds, subjectId, req.user.id, {
    confirmDuplicates: Boolean(confirmDuplicates),
  });
  res.status(result.needsConfirmation.length > 0 ? 409 : 200).json(result);
}

async function rename(req, res) {
  const { filename } = req.body || {};
  res.json(await photoService.rename(req.params.id, filename, req.user.id));
}

async function archiveMany(req, res) {
  res.json(await photoService.archiveMany(req.body?.fileIds, req.user.id));
}

module.exports = {
  list, summary, detail, runOcr, runOcrForPending, moveMany, rename, archiveMany,
};
