// Word extraction (spec §7/§8, "Other relevant Microsoft-family formats").
// docx is a zip of XML parts; we read word/document.xml for body text and
// docProps/core.xml for standard metadata (title/author/dates), without
// pulling in a full docx parsing library.
const AdmZip = require("adm-zip");
const { stripXmlToText } = require("./ooxmlTextUtil");

function readEntryText(zip, entryName) {
  const entry = zip.getEntry(entryName);
  return entry ? zip.readAsText(entry) : null;
}

function parseCoreProps(xml) {
  if (!xml) return {};
  const get = (tag) => {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
    return m ? m[1] : null;
  };
  return {
    title: get("dc:title"),
    creator: get("dc:creator"),
    lastModifiedBy: get("cp:lastModifiedBy"),
    created: get("dcterms:created"),
    modified: get("dcterms:modified"),
  };
}

async function extract(buffer) {
  const zip = new AdmZip(buffer);

  const documentXml = readEntryText(zip, "word/document.xml");
  const coreXml = readEntryText(zip, "docProps/core.xml");
  const appXml = readEntryText(zip, "docProps/app.xml");

  const pagesMatch = appXml ? appXml.match(/<Pages>(\d+)<\/Pages>/) : null;
  const wordsMatch = appXml ? appXml.match(/<Words>(\d+)<\/Words>/) : null;

  return {
    extractor: "docx",
    extractorVersion: "adm-zip+regex",
    metadata: {
      ...parseCoreProps(coreXml),
      pageCount: pagesMatch ? parseInt(pagesMatch[1], 10) : null,
      wordCount: wordsMatch ? parseInt(wordsMatch[1], 10) : null,
    },
    text: documentXml ? stripXmlToText(documentXml) : "",
  };
}

module.exports = { extract };
