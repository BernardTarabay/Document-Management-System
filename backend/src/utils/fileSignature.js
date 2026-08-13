// Format detection by content, not filename extension (spec §7: "The system
// should not rely exclusively on file extensions"). Extension is used only
// as a fallback hint when the signature is ambiguous or unrecognized.
const AdmZip = require("adm-zip");

const SIGNATURES = [
  { family: "pdf", bytes: [0x25, 0x50, 0x44, 0x46] },              // %PDF
  { family: "ole-cfb", bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] }, // legacy .doc/.xls/.ppt
  { family: "zip", bytes: [0x50, 0x4b, 0x03, 0x04] },              // PK\x03\x04 (OOXML + pbix)
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
      return { family: sig.family, subtype: sig.family };
    }
  }

  const ext = extensionHint.replace(/^\./, "").toLowerCase();
  return { family: "unknown", subtype: ext || "unknown", fallbackToExtension: true };
}

module.exports = { detectSignature, disambiguateZipFamily };
