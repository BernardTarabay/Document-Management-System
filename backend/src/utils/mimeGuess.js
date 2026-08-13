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
};

function guessMimeType(extension, detectedFallback) {
  const ext = (extension || "").toLowerCase();
  return EXTENSION_MIME_MAP[ext] || detectedFallback || "application/octet-stream";
}

module.exports = { guessMimeType };
