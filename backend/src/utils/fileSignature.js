// Format detection by content, not filename extension (spec §7: "The system
// should not rely exclusively on file extensions"). Extension is used only
// as a fallback hint when the signature is ambiguous or unrecognized.
const AdmZip = require("adm-zip");

const SIGNATURES = [
  { family: "pdf", bytes: [0x25, 0x50, 0x44, 0x46] },              // %PDF
  { family: "ole-cfb", bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] }, // legacy .doc/.xls/.ppt
  { family: "zip", bytes: [0x50, 0x4b, 0x03, 0x04] },              // PK\x03\x04 (OOXML + pbix)

  // IMAGES.
  //
  // These were missing entirely, and the consequence was not cosmetic: with no
  // signature match a JPEG fell through to the extension fallback at the
  // bottom and was typed `unknown/jpeg`. thumbnailService tests the mime
  // against a list of real image types, `unknown/jpeg` is not on it, so every
  // photograph was routed to the LibreOffice rasteriser -- which is for
  // turning documents into pictures, is not installed here, and cannot render
  // a JPEG anyway. Result: "No preview available" on every single photo, on a
  // page whose entire purpose is looking at them.
  //
  // Each of these is the standard magic number for its format.
  { family: "image", subtype: "jpeg", bytes: [0xff, 0xd8, 0xff] },
  { family: "image", subtype: "png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { family: "image", subtype: "gif", bytes: [0x47, 0x49, 0x46, 0x38] },          // GIF8
  { family: "image", subtype: "bmp", bytes: [0x42, 0x4d] },                      // BM
  { family: "image", subtype: "tiff", bytes: [0x49, 0x49, 0x2a, 0x00] },         // little-endian
  { family: "image", subtype: "tiff", bytes: [0x4d, 0x4d, 0x00, 0x2a] },         // big-endian
];

function matchesSignature(buffer, sig) {
  if (buffer.length < sig.bytes.length) return false;
  for (let i = 0; i < sig.bytes.length; i += 1) {
    if (buffer[i] !== sig.bytes[i]) return false;
  }
  return true;
}

/**
 * Disambiguate a zip-family file into docx/xlsx/pptx/pbix/unknown-zip by
 * inspecting entry names -- these formats are all PK zips at the byte level,
 * so the signature alone is not enough (this is exactly the pbix trap called
 * out in spec §8: "do not assume a PBIX file can be treated like a normal
 * spreadsheet" -- it IS a zip, but a structurally different one).
 * @param {Buffer} buffer full file bytes (small/medium files) or a large-enough head+tail read
 */
function disambiguateZipFamily(buffer) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    return { family: "zip", subtype: "unreadable-zip", error: err.message };
  }

  const entryNames = zip.getEntries().map((e) => e.entryName);
  const has = (needle) => entryNames.some((n) => n.startsWith(needle));

  if (has("DataModel") || has("DataModelSchema") || has("Report/Layout")) {
    return { family: "zip", subtype: "pbix", entryNames };
  }
  if (has("word/document.xml")) {
    return { family: "zip", subtype: "docx", entryNames };
  }
  if (has("xl/workbook.xml")) {
    return { family: "zip", subtype: "xlsx", entryNames };
  }
  if (has("ppt/presentation.xml")) {
    return { family: "zip", subtype: "pptx", entryNames };
  }
  return { family: "zip", subtype: "unknown-zip", entryNames };
}

/**
 * @param {Buffer} buffer - at least the first ~2KB of the file; more (or the
 *   whole file) is needed for zip-family disambiguation.
 * @param {string} [extensionHint] - e.g. 'pdf', used only when signature is inconclusive
 */
function detectSignature(buffer, extensionHint = "") {
  for (const sig of SIGNATURES) {
    if (matchesSignature(buffer, sig)) {
      if (sig.family === "zip") {
        return disambiguateZipFamily(buffer);
      }
      // `subtype` when the entry declares one (the image formats all share
      // family "image" and differ only by subtype); otherwise it mirrors the
      // family, as it always did.
      return { family: sig.family, subtype: sig.subtype || sig.family };
    }
  }

  const ext = extensionHint.replace(/^\./, "").toLowerCase();
  return { family: "unknown", subtype: ext || "unknown", fallbackToExtension: true };
}

module.exports = { detectSignature, disambiguateZipFamily };
