// PDF extraction (spec §8): text, metadata, basic structure (page count).
//
// Uses pdfjs-dist directly rather than the popular `pdf-parse` wrapper --
// `pdf-parse` bundles a years-old, unmaintained pdf.js snapshot that threw
// "bad XRef entry" on a perfectly valid, freshly-generated PDF during
// testing (reportlab output). pdfjs-dist is Mozilla's actively maintained
// package and handled the same file correctly, so it's the direct
// dependency instead.
//
// "Detect document structure / identify relevant terms" beyond page count
// and raw text is left to the classification stage, which consumes this
// output -- this module's job is only to get faithful raw material out of
// the file.
const path = require("path");

async function extract(buffer) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    // Suppresses a benign warning about missing standard font metrics --
    // we only need text extraction, not pixel-accurate font rendering.
    useSystemFonts: true,
    standardFontDataUrl: path.join(
      path.dirname(require.resolve("pdfjs-dist/package.json")),
      "standard_fonts/"
    ),
  });

  const doc = await loadingTask.promise;
  const meta = await doc.getMetadata().catch(() => ({ info: {} }));

  let text = "";
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    text += content.items.map((item) => item.str).join(" ") + "\n";
  }

  await doc.destroy();

  return {
    extractor: "pdf",
    extractorVersion: "pdfjs-dist",
    metadata: {
      pageCount: doc.numPages,
      pdfFormatVersion: meta.info?.PDFFormatVersion || null,
      title: meta.info?.Title || null,
      author: meta.info?.Author || null,
      producer: meta.info?.Producer || null,
      creationDate: meta.info?.CreationDate || null,
    },
    text: text.trim(),
  };
}

module.exports = { extract };
