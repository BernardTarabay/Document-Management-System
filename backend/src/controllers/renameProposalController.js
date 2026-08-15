const renameProposalService = require("../services/renameProposalService");
const { ProposalStatus } = require("../models/enums");

async function list(req, res) {
  res.json(await renameProposalService.search(req.query, req.user.id));
}

async function approve(req, res) {
  res.json(await renameProposalService.review(req.params.id, ProposalStatus.APPROVED, req.user.id));
}

async function reject(req, res) {
  res.json(await renameProposalService.review(req.params.id, ProposalStatus.REJECTED, req.user.id));
}

async function retry(req, res) {
  res.json(await renameProposalService.retry(req.params.id, req.user.id));
}

async function bulkApply(req, res) {
  const job = await renameProposalService.bulkApply(req.body.proposalIds, req.user.id);
  res.status(202).json(job);
}

async function pendingCount(req, res) {
  res.json({ count: await renameProposalService.pendingCount(req.user.id) });
}

/** Dry run: how many pending proposals a threshold would approve. */
async function countAboveConfidence(req, res) {
  res.json(await renameProposalService.countPendingAboveConfidence(req.query.minConfidence, req.user.id));
}

async function approveAboveConfidence(req, res) {
  const result = await renameProposalService.approveAboveConfidence(req.body?.minConfidence, req.user.id);
  res.status(result.approved > 0 ? 202 : 200).json(result);
}

/** Dry run: how many pending proposals a threshold would discard. */
async function countBelowConfidence(req, res) {
  res.json(await renameProposalService.countPendingBelowConfidence(req.query.maxConfidence, req.user.id));
}

async function rejectBelowConfidence(req, res) {
  const result = await renameProposalService.rejectBelowConfidence(req.body?.maxConfidence, req.user.id);
  res.json(result);
}

module.exports = {
  list, approve, reject, retry, bulkApply, pendingCount,
  countAboveConfidence, approveAboveConfidence,
  countBelowConfidence, rejectBelowConfidence,
};