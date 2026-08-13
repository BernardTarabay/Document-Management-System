// PowerPoint extraction (spec §7/§8). pptx is a zip with one XML part per
// slide (ppt/slides/slideN.xml); we extract <a:t> text runs from each and
// keep slide count + per-slide text so classification can see slide-level
// granularity if useful later.
const AdmZip = require("adm-zip");
const { stripXmlToText } = require("./ooxmlTextUtil");

function readEntryText(zip, entryName) {
  const entry = zip.getEntry(entryName);
  return entry ? zip.readAsText(entry) : null;
}

// Same docProps/core.xml part every OOXML format has (see docxExtractor.js)
// -- pptx just never read it before. Feeds namingService's title-first
// naming: a deck's own "Title" property is often a better filename than
// anything a keyword scorer or even the AI tier would have to guess.
function parseCoreTitle(xml) {
  if (!xml) return null;
  const m = xml.match(/<dc:title[^>]*>([^<]*)<\/dc:title>/);
  return m ? m[1] : null;
}

async function extract(buffer) {
  const zip = new AdmZip(buffer);
  const slideEntries = zip
    .getEntries()
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => {
      const numA = parseInt(a.entryName.match(/slide(\d+)\.xml/)[1], 10);
      const numB = parseInt(b.entryName.match(/slide(\d+)\.xml/)[1], 10);
      return numA - numB;
    });

  const slides = slideEntries.map((entry) => {
    const xml = zip.readAsText(entry);
    return stripXmlToText(xml);
  });

  const coreXml = readEntryText(zip, "docProps/core.xml");

  return {
    extractor: "pptx",
    extractorVersion: "adm-zip+regex",
    metadata: {
      slideCount: slides.length,
      title: parseCoreTitle(coreXml),
    },
    text: slides.join("\n"),
  };
}

module.exports = { extract };
