// Power BI (.pbix) extraction -- spec §8 is explicit that a pbix must NOT be
// assumed to behave like a normal spreadsheet, and asks us to investigate
// what's reliably extractable rather than guess. Findings from that
// investigation, encoded here:
//
//   - A .pbix IS a zip container (same PK\x03\x04 signature as OOXML), which
//     is why fileSignature.js has to look at entry names, not just the
//     magic bytes, to tell it apart from docx/xlsx/pptx.
//   - "Version" is a small plain-text/JSON entry -- reliably readable.
//   - "Report/Layout" (when present) holds the visual/report structure as
//     JSON, but is UTF-16LE encoded with a BOM, not UTF-8 like the OOXML
//     parts above -- naive UTF-8 decoding silently produces garbage rather
//     than an error, which is a real footgun worth documenting.
//   - "DataModel" / "DataModelSchema" is the actual tabular data (measures,
//     tables, relationships), stored in a proprietary compressed xVelocity/
//     SSAS engine format. It is NOT text, NOT a documented open format, and
//     is explicitly NOT parsed here -- doing so reliably requires either the
//     Analysis Services engine or a reverse-engineered binary parser, both
//     out of scope for a content extractor. We record its presence/size only.
//   - "SecurityBindings" / "Settings" / "Connections" are small config blobs;
//     read opportunistically, not required.
//
// Net effect: pbix gets structural metadata (does it have a data model? how
// many report pages/visuals per Report/Layout?) but never full "extracted
// text" in the way PDFs/Office docs do. That's a deliberate, documented
// limitation, not an oversight.
const AdmZip = require("adm-zip");

function tryReadUtf16(zip, entryName) {
  const entry = zip.getEntry(entryName);
  if (!entry) return null;
  try {
    const buf = zip.readFile(entry);
    // Report/Layout is typically UTF-16LE with a BOM (FF FE).
    const hasBom = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
    const text = hasBom ? buf.slice(2).toString("utf16le") : buf.toString("utf8");
    return text;
  } catch (err) {
    return null;
  }
}

function countReportPages(layoutJsonText) {
  if (!layoutJsonText) return null;
  try {
    const layout = JSON.parse(layoutJsonText);
    return Array.isArray(layout.sections) ? layout.sections.length : null;
  } catch (err) {
    return null; // Layout schema varies across Power BI Desktop versions; don't fail extraction over it.
  }
}

async function extract(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const entryNames = entries.map((e) => e.entryName);

  const versionText = tryReadUtf16(zip, "Version");
  const layoutText = tryReadUtf16(zip, "Report/Layout");
  const dataModelEntry = entries.find(
    (e) => e.entryName === "DataModel" || e.entryName === "DataModelSchema"
  );

  return {
    extractor: "pbix",
    extractorVersion: "adm-zip (investigation-only, see module comment)",
    metadata: {
      containerEntryCount: entryNames.length,
      hasDataModel: Boolean(dataModelEntry),
      dataModelSizeBytes: dataModelEntry ? dataModelEntry.header.size : null,
      version: versionText ? versionText.trim() : null,
      reportPageCount: countReportPages(layoutText),
      dataModelParsed: false, // explicit: we never parse the xVelocity/SSAS payload
    },
    // No reliable full-text extraction for the data model; report layout text
    // (visual titles, text boxes) is the only human-authored text we can get.
    text: layoutText ? extractVisibleStrings(layoutText) : "",
  };
}

// Report/Layout JSON contains a lot of structural noise; pull out just the
// string-valued leaves so classification has something to key off (titles,
// text-box contents) without needing to understand the full schema.
function extractVisibleStrings(layoutJsonText) {
  try {
    const layout = JSON.parse(layoutJsonText);
    const strings = [];
    const MAX_STRINGS = 500;
    (function walk(node) {
      if (strings.length >= MAX_STRINGS || node == null) return;
      if (typeof node === "string") {
        if (node.length > 1 && node.length < 200) strings.push(node);
        return;
      }
      if (Array.isArray(node)) {
        node.forEach(walk);
      } else if (typeof node === "object") {
        Object.values(node).forEach(walk);
      }
    })(layout);
    return strings.join(" ");
  } catch (err) {
    return "";
  }
}

module.exports = { extract };
