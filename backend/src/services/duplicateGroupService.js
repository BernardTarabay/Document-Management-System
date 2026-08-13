const duplicateGroupRepository = require("../repositories/duplicateGroupRepository");
const auditLogRepository = require("../repositories/auditLogRepository");
const { enqueueJob } = require("../queues");
const { parsePagination } = require("../utils/pagination");
const { ValidationError } = require("../validators/validationError");
const { JobType, DuplicateGroupType } = require("../models/enums");

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
    this.publicMessage = message;
  }
}

async function search(query) {
  const { limit, offset } = parsePagination(query);
  if (!query.status || query.status === "open") return duplicateGroupRepository.listOpen({ limit, offset });
  return duplicateGroupRepository.list({ limit, offset });
}

async function getById(id) {
  const group = await duplicateGroupRepository.findById(id);
  if (!group) throw new NotFoundError("Duplicate group not found.");
  const members = await duplicateGroupRepository.listMembers(id);
  return {
    ...group,
    // size_bytes is a bigint, which pg hands back as a string -- left alone,
    // the UI's byte formatter gets "4194304" and every comparison between
    // copies becomes a string comparison.
    members: members.map((m) => ({
      ...m,
      size_bytes: m.size_bytes === null ? null : Number(m.size_bytes),
      text_length: m.text_length === null ? null : Number(m.text_length),
    })),
  };
}

/**
 * Sets which File is treated as canonical within the group -- never deletes
 * the other members (spec §13: "must never automatically delete files
 * merely because they appear similar").
 */
async function resolve(id, { canonicalFileId }, actorUserId) {
  if (!canonicalFileId) throw new ValidationError("canonicalFileId is required.");
  const group = await duplicateGroupRepository.findById(id);
  if (!group) throw new NotFoundError("Duplicate group not found.");

  const members = await duplicateGroupRepository.listMembers(id);
  if (!members.some((m) => m.file_id === canonicalFileId)) {
    throw new ValidationError("canonicalFileId must be a member of this duplicate group.");
  }

  const resolved = await duplicateGroupRepository.setCanonicalFile(id, canonicalFileId, actorUserId);

  await auditLogRepository.record({
    userId: actorUserId,
    action: "duplicate.merged",
    entityType: "duplicate_group",
    entityId: id,
    previousState: { status: group.status, canonicalFileId: group.canonical_file_id },
    newState: { status: "resolved", canonicalFileId },
    reason: "Canonical file selected by user",
  });

  return resolved;
}

/**
 * Heuristic for the auto-resolve job: which member of an EXACT-duplicate
 * group (identical SHA-256 -- content is byte-for-byte the same either
 * way) should be treated as canonical. Since the bytes can't
 * differentiate them, this scores on metadata quality instead:
 *   +10  already has a real title from the naming pipeline (ai_short_title
 *        set) -- means this copy has actually been reviewed/processed
 *   +5   current filename doesn't look like an auto-deduped copy
 *        ("Invoice (2).pdf", "photo_copy.jpg", "duplicate-report.docx")
 * Ties broken by earliest import (the first copy seen stands in as "the
 * original"), then by file id for determinism.
 */
const COPY_LIKE_FILENAME = /\(\d+\)|[\s_-]copy\b|duplicate/i;

function scoreMemberForCanonical(member) {
  let score = 0;
  if (member.ai_short_title) score += 10;
  if (!COPY_LIKE_FILENAME.test(member.filename_current)) score += 5;
  return score;
}

function pickCanonicalMember(members) {
  if (!members.length) return null;
  return [...members].sort((a, b) => {
    const scoreDiff = scoreMemberForCanonical(b) - scoreMemberForCanonical(a);
    if (scoreDiff !== 0) return scoreDiff;
    const dateDiff = new Date(a.imported_at) - new Date(b.imported_at);
    if (dateDiff !== 0) return dateDiff;
    return String(a.file_id).localeCompare(String(b.file_id));
  })[0];
}

/**
 * Resolves one group automatically -- same effect as a human clicking
 * "Set canonical" (never deletes any member, spec §13), just with the pick
 * made by pickCanonicalMember() instead of a person. Returns null (not an
 * error) for a group that's no longer open or has no members, so the job
 * processor can treat that as "nothing to do" rather than a failure.
 */
async function autoResolveGroup(groupId, actorUserId) {
  const group = await duplicateGroupRepository.findById(groupId);
  if (!group || group.status !== "open") return null;

  // Defense in depth alongside the 'exact' filter the job passes to
  // listOpen(). A PROBABLE group is a suggestion built from content
  // similarity, not proof; docs/01-domain-model.md §1.3 forbids resolving
  // one without a human. The heuristic below is also simply invalid for
  // them -- it assumes the members are byte-identical, so "which copy is
  // canonical" is a metadata-quality question. For probable duplicates the
  // files genuinely differ, and picking a winner could discard real content.
  if (group.group_type !== DuplicateGroupType.EXACT) return null;

  const members = await duplicateGroupRepository.listMembers(groupId);
  if (members.length === 0) return null;

  const winner = pickCanonicalMember(members);
  const resolved = await duplicateGroupRepository.setCanonicalFile(groupId, winner.file_id, actorUserId);

  await auditLogRepository.record({
    userId: actorUserId,
    action: "duplicate.auto_resolved",
    entityType: "duplicate_group",
    entityId: groupId,
    previousState: { status: group.status, canonicalFileId: group.canonical_file_id },
    newState: { status: "resolved", canonicalFileId: winner.file_id },
    reason:
      `Auto-resolved: picked "${winner.filename_current}" as canonical out of ${members.length} identical ` +
      `copies (${winner.ai_short_title ? "already had a real title from the naming pipeline" : "earliest import among otherwise-equal copies"}).`,
  });

  return resolved;
}

/** Enqueues the auto_resolve_duplicates job -- see autoResolveDuplicatesProcessor.js. */
async function enqueueAutoResolveAll(actorUserId) {
  // Only EXACT groups are auto-resolvable, so the progress total must count
  // only those -- otherwise the job reports a total it will never reach.
  const total = await duplicateGroupRepository.countOpen(DuplicateGroupType.EXACT);
  const job = await enqueueJob(
    JobType.AUTO_RESOLVE_DUPLICATES,
    { actorUserId },
    { createdBy: actorUserId, progressTotal: total }
  );

  await auditLogRepository.record({
    userId: actorUserId,
    action: "duplicate.auto_resolve_all.started",
    entityType: "processing_job",
    entityId: job.id,
    newState: { processingJobId: job.id, openGroupCount: total },
    reason: "Bulk auto-resolve triggered from the Duplicate groups page",
  });

  return job;
}

module.exports = {
  NotFoundError, search, getById, resolve,
  pickCanonicalMember, autoResolveGroup, enqueueAutoResolveAll,
};
