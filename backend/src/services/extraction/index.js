// Modular extraction registry (spec §8: "Content extraction must be designed
// as a modular subsystem"). Adding a new format is: write a module exposing
// `extract(buffer) -> {extractor, extractorVersion, metadata, text}`, then
// add one line here. Nothing else in the pipeline needs to change.
const { detectSignature } = require("../../utils/fileSignature");

const pdfExtractor = require("./pdfExtractor");
const xlsxExtractor = require("./xlsxExtractor");
const docxExtractor = require("./docxExtractor");
const pptxExtractor = require("./pptxExtractor");
const pbixExtractor = require("./pbixExtractor");
const oleCfbExtractor = require("./oleCfbExtractor");

const EXTRACTORS_BY_SUBTYPE = {
  pdf: pdfExtractor,
  xlsx: xlsxExtractor,
  docx: docxExtractor,
  pptx: pptxExtractor,
  pbix: pbixExtractor,
  // Legacy Office 97-2003. All three of .doc/.xls/.ppt share the one
  // compound-file signature, so a single entry handles them and dispatches
  // internally on which document stream the container actually holds.
  "ole-cfb": oleCfbExtractor,
};

// Unrecognized zips remain unsupported -- see docs/07-supported-formats.md.
const UNSUPPORTED_RESULT = (reason) => ({
  extractor: "unsupported",
  extractorVersion: null,
  metadata: { reason },
  text: "",
});

/**
 * @param {Buffer} buffer
 * @param {string} [extensionHint]
 * @returns {Promise<{extractor:string, extractorVersion:string|null, metadata:object, text:string}>}
 */
async function extractContent(buffer, extensionHint = "") {
  const signature = detectSignature(buffer, extensionHint);
  const subtype = signature.subtype;

  const extractor = EXTRACTORS_BY_SUBTYPE[subtype];
  if (!extractor) {
    return UNSUPPORTED_RESULT(
      `No extractor registered for detected format "${subtype}" ` +
      `(signature family: ${signature.family}, extension hint: "${extensionHint}")`
    );
  }

  try {
    const result = await extractor.extract(buffer);
    return { ...result, detectedSubtype: subtype };
  } catch (err) {
    return UNSUPPORTED_RESULT(`Extractor "${subtype}" failed: ${err.message}`);
  }
}

module.exports = { extractContent };
