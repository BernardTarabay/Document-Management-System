// Tiny extension -> MIME map for download responses. This is presentation
// only (what the browser is told to do with the bytes) -- it never
// influences format DETECTION, which is always signature-based
// (utils/fileSignature.js). Falls back to the detected signature string or
// a generic binary type if unknown.
const EXTENSION_MIME_MAP = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  pbix: "application/octet-stream",

  // Images. Absent before, which meant a JPEG's mime came from the signature
  // detector's fallback string ("unknown/jpeg") and nothing downstream
  // recognised it as an image -- see the note in fileSignature.js.
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jpe: "image/jpeg",
  jfif: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
  svg: "image/svg+xml",
  txt: "text/plain",
  csv: "text/csv",
};

/**
 * `detectedFallback` is consulted only when the extension is unknown, and it
 * is REJECTED when it looks like the signature detector's own fallback rather
 * than a real media type. "unknown/jpeg" is not a mime type; handing it to a
 * browser, or comparing it against a list of real ones, fails silently in both
 * directions.
 */
function guessMimeType(extension, detectedFallback) {
  const ext = (extension || "").toLowerCase().replace(/^\./, "");
  if (EXTENSION_MIME_MAP[ext]) return EXTENSION_MIME_MAP[ext];
  if (detectedFallback && !String(detectedFallback).startsWith("unknown/")) {
    return detectedFallback;
  }
  return "application/octet-stream";
}

module.exports = { guessMimeType };
