// Rule-based baseline classifier (spec §11). Keyword-matches filename +
// extracted text against the seeded taxonomy/document types. This is
// deliberately simple and transparent (every match is explainable in
// raw_output) rather than a black-box model -- a stronger classifier
// (ML/LLM) can be swapped in later behind the same ClassificationResult
// shape (method: 'ml'|'llm') without changing anything downstream, per
// Phase 1 §1.5's confidence-gating design.
const fileRepository = require("../../repositories/fileRepository");
const fileMetadataRepository = require("../../repositories/fileMetadataRepository");
const fileContentRepository = require("../../repositories/fileContentRepository");
const subjectRepository = require("../../repositories/subjectRepository");
const documentTypeRepository = require("../../repositories/documentTypeRepository");
const classificationResultRepository = require("../../repositories/classificationResultRepository");
const auditLogRepository = require("../../repositories/auditLogRepository");
const { enqueueJob } = require("../../queues");
const { ConfidenceLevel, ClassificationMethod, JobType } = require("../../models/enums");
const env = require("../../config/env");
const geminiClassifier = require("../../services/ai/geminiClassifier");

const CONFIDENCE_ORDER = { low: 0, medium: 1, high: 2 };

/** Escalate when the rule-based pass landed below the configured confidence
 * floor (default "high" -- i.e. escalate low/medium only). Set
 * AI_ESCALATE_BELOW_CONFIDENCE=always to run Gemini on every file
 * regardless of rule-based confidence, as a second-opinion check even on
 * clean keyword matches -- generateNamesProcessor still only proposes a
 * rename from whichever classification_results row is most recent, so if
 * Gemini disagrees with (or is less confident than) a "high" rule-based
 * match, that disagreement correctly holds the rename back rather than
 * blindly trusting either pass alone. */
function shouldEscalateToAi(ruleConfidenceLevel) {
  if (env.ai.escalateBelowConfidence === "always") return true;
  const threshold = CONFIDENCE_ORDER[env.ai.escalateBelowConfidence] ?? CONFIDENCE_ORDER.high;
  return CONFIDENCE_ORDER[ruleConfidenceLevel] < threshold;
}

/**
 * The LLM escalation tier (docs/09-ai-classification.md). Two cost levers
 * before ever calling out to Gemini: (1) reuse a sibling file's AI result
 * when the content hash already matches one that's been classified, so
 * duplicates never cost a second call; (2) a persisted daily call cap
 * (counted from audit_logs, so it survives worker restarts) that silently
 * falls back to the rule-based result once reached rather than erroring.
 * A failed or skipped AI pass never takes down the pipeline -- the
 * rule-based classification_results row created by handle() above already
 * stands on its own either way.
 */
async function runAiEscalation({ file, bodyText, allSubjects, allDocTypes, embeddedTitle }) {
  try {
    // Nothing to read. With no usable text and no embedded title the model
    // would be guessing from a filename alone -- which is precisely how a
    // scanned "IMG_0042.pdf" acquires an authoritative-sounding invented
    // title. Skipping also saves an API call per unreadable file, and on a
    // drive full of scans that is most of them.
    if (!String(bodyText || "").trim() && !embeddedTitle) {
      await auditLogRepository.record({
        action: "ai_classification.skipped",
        entityType: "file",
        entityId: file.id,
        reason:
          "No usable text and no embedded title -- the AI tier had nothing to read, so it was not called. " +
          "The file keeps its existing name.",
      });
      return;
    }

    if (file.sha256_hash) {
      const sibling = await fileRepository.findClassifiedSiblingByHash(
        file.sha256_hash, file.id, file.owner_user_id
      );
      if (sibling) {
        await fileRepository.updateAiEnrichment(file.id, {
          shortTitle: sibling.ai_short_title,
          summary: sibling.ai_summary,
          entities: sibling.ai_entities,
        });
        const siblingResults = await classificationResultRepository.listProposedForFile(sibling.id);
        const siblingLlmResult = siblingResults.find((r) => r.method === ClassificationMethod.LLM);
        if (siblingLlmResult) {
          await classificationResultRepository.create({
            fileId: file.id,
            classifiedSubjectId: siblingLlmResult.classified_subject_id,
            classifiedDocumentTypeId: siblingLlmResult.classified_document_type_id,
            confidenceLevel: siblingLlmResult.confidence_level,
            confidenceScore: siblingLlmResult.confidence_score,
            method: ClassificationMethod.LLM,
            rawOutput: {
              reusedFromFileId: sibling.id,
              reason: "identical content hash (exact duplicate) -- reused sibling's AI classification instead of calling Gemini again",
            },
          });
        }
        return;
      }
    }

    if (env.ai.dailyCallCap > 0) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const callsToday = await auditLogRepository.countSince("ai_classification.called", since);
      if (callsToday >= env.ai.dailyCallCap) {
        await auditLogRepository.record({
          action: "ai_classification.skipped",
          entityType: "file",
          entityId: file.id,
          reason: `Daily AI classification cap (${env.ai.dailyCallCap}) reached; kept the rule-based result.`,
        });
        return;
      }
    }

    const classified = await geminiClassifier.classify({
      filename: file.filename_current,
      bodyText,
      subjects: allSubjects,
      documentTypes: allDocTypes,
      embeddedTitle,
    });

    await classificationResultRepository.create({
      fileId: file.id,
      classifiedSubjectId: classified.subject?.id || null,
      classifiedDocumentTypeId: classified.documentType?.id || null,
      confidenceLevel: classified.confidenceLevel,
      confidenceScore: { low: 0.3, medium: 0.6, high: 0.9 }[classified.confidenceLevel],
      method: ClassificationMethod.LLM,
      rawOutput: {
        shortTitle: classified.shortTitle,
        summary: classified.summary,
        entities: classified.entities,
        usage: classified.usage,
        interactionId: classified.interactionId,
      },
    });

    await fileRepository.updateAiEnrichment(file.id, {
      shortTitle: classified.shortTitle,
      summary: classified.summary,
      entities: classified.entities,
    });

    await auditLogRepository.record({
      action: "ai_classification.called",
      entityType: "file",
      entityId: file.id,
      newState: { usage: classified.usage },
      status: "success",
    });
  } catch (err) {
    await auditLogRepository.record({
      action: "ai_classification.called",
      entityType: "file",
      entityId: file.id,
      reason: err.message,
      status: "failed",
    });

    // Swallowing is correct for an UPSTREAM failure -- Gemini being down, a
    // timeout, a 429 -- because the rule-based result already stands and the
    // file is classified either way. That is what this catch was written for.
    //
    // It was swallowing more than that. The try block also covers the three
    // database writes above, so a failure to store a classification the API
    // call had already been billed for, or to write the AI enrichment fields,
    // was recorded as "ai_classification failed" and the job then reported
    // SUCCESS. Nothing retried, and the money was spent for a result that was
    // never saved.
    //
    // A DB error is not an AI-tier problem: rethrow it and let BullMQ retry,
    // which is exactly the case retries exist for.
    const isUpstreamFailure =
      err instanceof geminiClassifier.GeminiClassificationError ||
      err.name === "AbortError" ||
      err.code === "ETIMEDOUT" ||
      err.code === "ECONNRESET" ||
      err.code === "ENOTFOUND";

    if (!isUpstreamFailure) throw err;
  }
}

function scoreKeywordMatches(haystack, keywords) {
  let matches = 0;
  const matched = [];
  for (const kw of keywords) {
    if (!kw) continue;
    if (haystack.includes(kw.toLowerCase())) {
      matches += 1;
      matched.push(kw);
    }
  }
  return { matches, matched };
}

async function handle({ fileId }) {
  const file = await fileRepository.findById(fileId);
  if (!file || file.status === "deleted" || file.status === "missing") {
    return { skipped: true, reason: "file not active" };
  }

  const [metadata, content, allSubjects, allDocTypes] = await Promise.all([
    fileMetadataRepository.findByFile(fileId),
    fileContentRepository.findByFile(fileId),
    subjectRepository.list({ limit: 1000 }),
    documentTypeRepository.list({ limit: 1000 }),
  ]);

  const filenameText = `${file.filename_original} ${file.filename_current}`.toLowerCase();

  // Text the extraction stage judged unusable is treated as absent, not as
  // content. Keyword-matching noise produces accidental hits, and -- far
  // worse -- sending it to the AI tier gets back a fluent, confident title
  // invented from nothing, which becomes a rename proposal against a real
  // document. See services/extraction/textQuality.js.
  const textIsUsable = !content?.text_quality || content.text_quality === "ok";
  const usableText = textIsUsable ? content?.extracted_text || "" : "";
  const bodyText = usableText.toLowerCase().slice(0, 20000);

  // Filename matches count more -- a match in the name itself is much
  // stronger signal than an incidental word appearing somewhere in the body.
  let bestSubject = null;
  let bestSubjectScore = 0;
  let bestSubjectInFilename = false;
  for (const subject of allSubjects) {
    const keywords = [subject.name, subject.slug];
    const filenameHit = scoreKeywordMatches(filenameText, keywords);
    const bodyHit = scoreKeywordMatches(bodyText, keywords);
    const score = filenameHit.matches * 3 + bodyHit.matches;
    if (score > bestSubjectScore) {
      bestSubjectScore = score;
      bestSubject = subject;
      bestSubjectInFilename = filenameHit.matches > 0;
    }
  }

  let bestDocType = null;
  let bestDocTypeScore = 0;
  let bestDocTypeInFilename = false;
  for (const docType of allDocTypes) {
    const keywords = [docType.name, docType.code].flatMap((k) => k.split(/(?=[A-Z])/)); // split "AnnualBudget" -> ["Annual","Budget"]
    const filenameHit = scoreKeywordMatches(filenameText, keywords);
    const bodyHit = scoreKeywordMatches(bodyText, keywords);
    const score = filenameHit.matches * 3 + bodyHit.matches;
    if (score > bestDocTypeScore) {
      bestDocTypeScore = score;
      bestDocType = docType;
      bestDocTypeInFilename = filenameHit.matches > 0;
    }
  }

  if (!bestSubject && !bestDocType) {
    const result = await classificationResultRepository.create({
      fileId,
      classifiedSubjectId: null,
      classifiedDocumentTypeId: null,
      confidenceLevel: ConfidenceLevel.LOW,
      confidenceScore: 0,
      method: ClassificationMethod.RULE,
      rawOutput: { reason: "no keyword matches against seeded taxonomy" },
    });

    // A total keyword miss is exactly the case the AI tier exists for --
    // always eligible to escalate regardless of the configured threshold.
    if (env.ai.enabled) {
      await runAiEscalation({ file, bodyText: usableText, allSubjects, allDocTypes, embeddedTitle: metadata?.metadata?.title || null });
    }
    // generateNamesProcessor re-reads the latest classification_results row
    // itself and no-ops if it's still low confidence, so it's always safe
    // to enqueue here rather than duplicating that decision.
    await enqueueJob(JobType.GENERATE_NAMES, { fileId }, {});

    return { classificationResultId: result.id, confidenceLevel: "low" };
  }

  const inFilename = bestSubjectInFilename || bestDocTypeInFilename;
  const totalScore = bestSubjectScore + bestDocTypeScore;
  // Bug fix (real-world report): a file got confidently renamed after a
  // SINGLE incidental keyword hit somewhere in 20,000 characters of body
  // text (totalScore=1 was enough for "medium", which was enough for
  // generateNamesProcessor to propose a rename). A lone body-only mention
  // is noise, not signal -- now MEDIUM requires either an actual filename
  // hit (a much stronger signal) or at least two independent body matches.
  const confidenceLevel = inFilename && totalScore >= 4
    ? ConfidenceLevel.HIGH
    : (inFilename || totalScore >= 2)
      ? ConfidenceLevel.MEDIUM
      : ConfidenceLevel.LOW;
  const confidenceScore = Math.min(0.99, totalScore / 10);

  const result = await classificationResultRepository.create({
    fileId,
    classifiedSubjectId: bestSubject?.id || null,
    classifiedDocumentTypeId: bestDocType?.id || null,
    confidenceLevel,
    confidenceScore,
    method: ClassificationMethod.RULE,
    rawOutput: {
      subjectMatch: bestSubject ? { id: bestSubject.id, name: bestSubject.name, score: bestSubjectScore } : null,
      documentTypeMatch: bestDocType ? { id: bestDocType.id, code: bestDocType.code, score: bestDocTypeScore } : null,
      matchedInFilename: inFilename,
    },
  });

  if (env.ai.enabled && shouldEscalateToAi(confidenceLevel)) {
    await runAiEscalation({ file, bodyText: usableText, allSubjects, allDocTypes, embeddedTitle: metadata?.metadata?.title || null });
  }

  await enqueueJob(JobType.GENERATE_NAMES, { fileId }, {});

  return { classificationResultId: result.id, confidenceLevel };
}

module.exports = { handle };