// job_type -> processor module registry. Adding a new stage is: write a
// processor exposing handle(payload, bullJob), add one line here, and (if it
// should be independently queued) confirm the job_type enum value exists in
// migration 001. Nothing else needs to change.
const { JobType } = require("../models/enums");

const scanProcessor = require("./processors/scanProcessor");
const hashProcessor = require("./processors/hashProcessor");
const extractMetadataProcessor = require("./processors/extractMetadataProcessor");
const extractTextProcessor = require("./processors/extractTextProcessor");
const classifyProcessor = require("./processors/classifyProcessor");
const detectDuplicatesProcessor = require("./processors/detectDuplicatesProcessor");
const generateNamesProcessor = require("./processors/generateNamesProcessor");
const bulkRenameProcessor = require("./processors/bulkRenameProcessor");
const bulkDeleteProcessor = require("./processors/bulkDeleteProcessor");
const autoResolveDuplicatesProcessor = require("./processors/autoResolveDuplicatesProcessor");
const emailSyncProcessor = require("./processors/emailSyncProcessor");
const detectVersionsProcessor = require("./processors/detectVersionsProcessor");
const reindexProcessor = require("./processors/reindexProcessor");
const syncMirrorProcessor = require("./processors/syncMirrorProcessor");
const ocrProcessor = require("./processors/ocrProcessor");
const describeProcessor = require("./processors/describeProcessor");

// `bulk_move` and `replicate` are the job_types with no processor here.
//
// `bulk_move` was superseded by bulk_rename, which can already carry a new
// folder via `proposed_relative_dir` (docs/06-processing-pipeline.md §6.1);
// filing a document under a subject is a database-only operation handled
// synchronously by fileOrganizeService, so it never needed a queue.
//
// `replicate` exists in the enum for the opt-in server-side copy described in
// migration 030, and is NOT implemented. Enqueuing either sits queued and
// unpicked rather than silently pretending to run -- an honest failure mode.
const PROCESSORS = {
  [JobType.SCAN]: scanProcessor,
  [JobType.HASH]: hashProcessor,
  [JobType.EXTRACT_METADATA]: extractMetadataProcessor,
  [JobType.EXTRACT_TEXT]: extractTextProcessor,
  [JobType.CLASSIFY]: classifyProcessor,
  [JobType.DETECT_DUPLICATES]: detectDuplicatesProcessor,
  [JobType.DETECT_VERSIONS]: detectVersionsProcessor,
  [JobType.REINDEX]: reindexProcessor,
  [JobType.SYNC_MIRROR]: syncMirrorProcessor,
  [JobType.OCR]: ocrProcessor,
  [JobType.DESCRIBE]: describeProcessor,
  [JobType.GENERATE_NAMES]: generateNamesProcessor,
  [JobType.BULK_RENAME]: bulkRenameProcessor,
  [JobType.BULK_DELETE]: bulkDeleteProcessor,
  [JobType.AUTO_RESOLVE_DUPLICATES]: autoResolveDuplicatesProcessor,
  [JobType.EMAIL_SYNC]: emailSyncProcessor,
};

module.exports = { PROCESSORS };
