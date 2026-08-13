// Metadata extraction stage (spec §8). Writes to file_metadata only; text
// goes through extractTextProcessor.js separately (see docs/06 §6.1 note on
// stage independence -- each parses the file itself so either stage can be
// retried without the other, at the cost of parsing twice per file, a
// deliberate, documented tradeoff for a first pass).
const fileRepository = require("../../repositories/fileRepository");
const storageLocationRepository = require("../../repositories/storageLocationRepository");
const fileMetadataRepository = require("../../repositories/fileMetadataRepository");
const { getStorageServiceFor } = require("../../services/storage/storageService");
const { streamToBuffer } = require("../../utils/streamToBuffer");
const { extractContent } = require("../../services/extraction");
const { detectSignature } = require("../../utils/fileSignature");
const { resolveDocumentDate } = require("../../services/extraction/documentDate");
const env = require("../../config/env");

async function handle({ fileId }) {
  const file = await fileRepository.findById(fileId);
  if (!file || file.status === "deleted" || file.status === "missing") {
    return { skipped: true, reason: "file not active" };
  }

  const storageLocation = await storageLocationRepository.findById(file.storage_location_id);
  const storageService = getStorageServiceFor(storageLocation);

  // Same ceiling as extractTextProcessor, and for the same reason -- this
  // buffers the whole file too, on a different queue, so without a guard here
  // the two stages would between them hold two full copies of an arbitrarily
  // large file at once. See env.extraction.maxBytes.
  const sizeBytes = Number(file.size_bytes) || 0;
  if (sizeBytes > env.extraction.maxBytes) {
    await fileMetadataRepository.upsert(fileId, {
      extractor: "skipped",
      extractorVersion: null,
      metadata: { skipped: "file too large", sizeBytes, maxBytes: env.extraction.maxBytes },
      extractionStatus: "skipped",
    });
    return { skipped: true, reason: "file too large to extract", sizeBytes };
  }

  const buffer = await streamToBuffer(storageService.readStream(file.current_path));

  const signature = detectSignature(buffer, file.extension);
  const result = await extractContent(buffer, file.extension);

  await fileMetadataRepository.upsert(fileId, {
    extractor: result.extractor,
    extractorVersion: result.extractorVersion,
    metadata: result.metadata,
    extractionStatus: result.extractor === "unsupported" ? "skipped" : "completed",
  });
  await fileRepository.updateMimeDetected(fileId, `${signature.family}/${signature.subtype}`);

  // When the document is FROM, which is not when the file was copied here.
  // Resolved even for unsupported formats -- those still fall back to the
  // filesystem, and a labelled guess beats an empty column.
  const { date, source } = resolveDocumentDate(result.metadata, {
    createdAtFs: file.created_at_fs,
    modifiedAtFs: file.modified_at_fs,
  });
  await fileRepository.setDocumentDate(fileId, date, source);

  return { extractor: result.extractor, signature, documentDate: date, documentDateSource: source };
}

module.exports = { handle };
