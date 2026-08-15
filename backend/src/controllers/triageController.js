const triageService = require("../services/triageService");

async function list(req, res) {
  res.json(await triageService.list(req.query, req.user.id));
}

async function summary(req, res) {
  res.json(await triageService.summary(req.user.id));
}

/** Everything needed to decide about one file, in one request. */
async function inspect(req, res) {
  res.json(await triageService.inspect(req.params.id, req.user.id));
}

async function retry(req, res) {
  res.json(await triageService.retry(req.params.id, req.user.id));
}

/**
 * File a triaged document under a folder.
 *
 * Answers 409 when the duplicate guard found something worth interrupting
 * for. That is not an error the client should swallow -- the body carries the
 * findings and the actions available on each, and the UI walks the user
 * through them before calling back with confirmDuplicate.
 */
async function moveToSubject(req, res) {
  const { subjectId, confirmDuplicate, note } = req.body || {};
  const result = await triageService.moveToSubject(
    req.params.id,
    { subjectId, confirmDuplicate: Boolean(confirmDuplicate), note },
    req.user.id
  );
  res.status(result.moved ? 200 : 409).json(result);
}

async function rename(req, res) {
  const { filename } = req.body || {};
  res.json(await triageService.rename(req.params.id, filename, req.user.id));
}

/** "The name it already has is the right one" -- a finished state. */
async function keepOriginalName(req, res) {
  res.json(await triageService.keepOriginalName(req.params.id, req.user.id));
}

async function archive(req, res) {
  res.json(await triageService.archive(req.params.id, req.user.id));
}

async function checkDuplicates(req, res) {
  res.json(await triageService.checkDuplicates(req.params.id, req.user.id));
}


/** File several triaged documents at once. 409 when the guard stopped some. */
async function moveMany(req, res) {
  const { fileIds, subjectId, confirmDuplicates } = req.body || {};
  const result = await triageService.moveMany(fileIds, subjectId, req.user.id, {
    confirmDuplicates: Boolean(confirmDuplicates),
  });
  res.status(result.needsConfirmation.length > 0 ? 409 : 200).json(result);
}

/** Remove one file from the working set. Nothing is erased from disk. */
async function remove(req, res) {
  res.json(await triageService.remove(req.params.id, req.user.id));
}

async function removeMany(req, res) {
  res.json(await triageService.removeMany(req.body?.fileIds, req.user.id));
}

module.exports = {
  list, summary, inspect, retry,
  moveToSubject, moveMany, rename, keepOriginalName, archive, checkDuplicates,
  remove, removeMany,
};
