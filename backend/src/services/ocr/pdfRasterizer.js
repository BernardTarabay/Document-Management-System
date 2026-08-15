// Turning a scanned PDF into images Tesseract can read.
//
// Tesseract accepts PNG/TIFF/JPEG and NOT PDF, so an image-only PDF -- which
// is what a scanner produces, and a large share of what needs OCR here -- has
// to be rasterised first.
//
// THREE STRATEGIES, TRIED IN ORDER, ALL REAL
//
//   1. pdftoppm (poppler)  the right tool. Fast, faithful, handles every PDF.
//   2. magick / convert    ImageMagick, which delegates to Ghostscript.
//   3. embedded images     no external tool at all: pull the page images
//                          straight out of the PDF with pdfjs-dist, which is
//                          already a dependency of this project.
//
// Strategy 3 is the interesting one. A scanned PDF is almost always one large
// image per page with no other content, so the embedded image IS the page --
// extracting it loses nothing and needs nothing installed. It does not work
// for a PDF whose pages are built from vector drawing or many small tiles, and
// this module says so rather than returning a blank page: a rasteriser that
// silently produces an empty image would make OCR "succeed" with no text,
// which reads as "this document is empty" instead of "we could not render it".
const { execFile } = require("child_process");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// 300 DPI is the usual floor for reliable OCR of body text; below ~200 error
// rates climb sharply on small print, above 400 the gain is marginal and the
// images get large enough to slow the whole pass down.
const DPI = parseInt(process.env.OCR_RASTER_DPI || "300", 10);

// A cap on how much of a long document is read. A 400-page scan is not what
// this feature is for, and OCR'ing all of it would occupy a worker for an
// hour; the first pages are what identify a document.
const MAX_PAGES = parseInt(process.env.OCR_MAX_PAGES || "10", 10);

const TIMEOUT_MS = parseInt(process.env.OCR_RASTER_TIMEOUT_MS || "120000", 10);

function run(binary, args) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); return; }
      resolve({ stdout, stderr });
    });
  });
}

async function which(candidates) {
  for (const candidate of candidates) {
    try {
      await run(candidate, ["-v"]);
      return candidate;
    } catch (err) {
      // Some of these report their version on a non-zero exit. ENOENT is the
      // only answer that actually means "not here".
      if (err.code !== "ENOENT" && err.code !== undefined) return candidate;
    }
  }
  return null;
}

async function makeWorkDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "atlas-raster-"));
}

async function listPages(dir) {
  const entries = await fsp.readdir(dir);
  return entries
    .filter((f) => /\.(png|tif|tiff|jpg|jpeg|ppm)$/i.test(f))
    .sort()
    .slice(0, MAX_PAGES)
    .map((f) => path.join(dir, f));
}

async function viaPdftoppm(pdfPath, dir) {
  const binary = await which([process.env.PDFTOPPM_PATH, "pdftoppm"].filter(Boolean));
  if (!binary) return null;
  await run(binary, ["-png", "-r", String(DPI), "-f", "1", "-l", String(MAX_PAGES), pdfPath, path.join(dir, "page")]);
  const pages = await listPages(dir);
  return pages.length ? pages : null;
}

async function viaImageMagick(pdfPath, dir) {
  const binary = await which([process.env.MAGICK_PATH, "magick", "convert"].filter(Boolean));
  if (!binary) return null;
  const args = binary.endsWith("magick") || binary === "magick"
    ? ["-density", String(DPI), `${pdfPath}[0-${MAX_PAGES - 1}]`, path.join(dir, "page-%03d.png")]
    : ["-density", String(DPI), `${pdfPath}[0-${MAX_PAGES - 1}]`, path.join(dir, "page-%03d.png")];
  await run(binary, args);
  const pages = await listPages(dir);
  return pages.length ? pages : null;
}

/**
 * Last resort, and the only one that needs nothing installed: lift the
 * embedded page images out with pdfjs-dist.
 *
 * Only claims success when it actually recovered images. A scanned page is one
 * big image; a page assembled from vector text has none, and for that this
 * correctly returns nothing so the caller can report an honest failure rather
 * than OCR a blank.
 */
async function viaEmbeddedImages(pdfPath, dir) {
  let pdfjs;
  try {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch {
    return null;
  }

  const data = new Uint8Array(await fsp.readFile(pdfPath));
  const doc = await pdfjs.getDocument({ data, disableWorker: true, isEvalSupported: false }).promise;

  const written = [];
  const pageCount = Math.min(doc.numPages, MAX_PAGES);

  for (let n = 1; n <= pageCount; n += 1) {
    const page = await doc.getPage(n);
    const ops = await page.getOperatorList();

    for (let i = 0; i < ops.fnArray.length; i += 1) {
      if (ops.fnArray[i] !== pdfjs.OPS.paintImageXObject) continue;
      const name = ops.argsArray[i][0];

      const img = await new Promise((resolve) => {
        try { page.objs.get(name, resolve); } catch { resolve(null); }
      });
      if (!img || !img.width || !img.height) continue;

      // pdfjs hands back raw RGB/RGBA samples. Writing a minimal uncompressed
      // PNM is enough -- Tesseract reads PNM natively, so there is no need to
      // pull in an image-encoding dependency purely to re-compress pixels that
      // are about to be thrown away.
      const pnm = toPnm(img);
      if (!pnm) continue;

      const out = path.join(dir, `page-${String(n).padStart(3, "0")}.ppm`);
      await fsp.writeFile(out, pnm);
      written.push(out);
      break; // one image per page is the scanned-document case
    }
    page.cleanup();
  }

  await doc.destroy();
  return written.length ? written : null;
}

/** Raw pdfjs image samples -> binary PPM (P6). */
function toPnm(img) {
  const { width, height, data } = img;
  if (!data || !width || !height) return null;

  const channels = data.length / (width * height);
  const rgb = Buffer.alloc(width * height * 3);

  if (channels >= 4) {
    for (let i = 0, o = 0; i < data.length; i += 4, o += 3) {
      rgb[o] = data[i]; rgb[o + 1] = data[i + 1]; rgb[o + 2] = data[i + 2];
    }
  } else if (channels === 3) {
    rgb.set(data.subarray(0, rgb.length));
  } else if (channels === 1) {
    for (let i = 0, o = 0; i < data.length; i += 1, o += 3) {
      rgb[o] = data[i]; rgb[o + 1] = data[i]; rgb[o + 2] = data[i];
    }
  } else {
    return null;
  }

  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`, "ascii"), rgb]);
}

/**
 * @returns {Promise<{ok: true, pages: string[], strategy: string, cleanup: () => Promise<void>}
 *                 | {ok: false, reason: string, permanent: boolean}>}
 */
async function rasterize(pdfPath) {
  const dir = await makeWorkDir();
  const cleanup = () => fsp.rm(dir, { recursive: true, force: true });

  const strategies = [
    ["pdftoppm", viaPdftoppm],
    ["imagemagick", viaImageMagick],
    ["embedded-images", viaEmbeddedImages],
  ];

  for (const [name, fn] of strategies) {
    try {
      const pages = await fn(pdfPath, dir);
      if (pages && pages.length) return { ok: true, pages, strategy: name, cleanup };
    } catch {
      // Try the next one. A tool that is installed but fails on this
      // particular PDF is a normal outcome, not a reason to stop.
    }
  }

  await cleanup();
  return {
    ok: false,
    // Not permanent: installing poppler makes this work, so it must not burn
    // the file's retry budget or mark it terminally failed.
    permanent: false,
    reason:
      "Could not turn this PDF into images for OCR. Atlas tried poppler (pdftoppm), ImageMagick, " +
      "and pulling the page images out of the PDF directly. For scanned PDFs the reliable fix is " +
      "to install poppler:\n" +
      "  Windows:  winget install --id oschwartz10612.Poppler\n" +
      "  macOS:    brew install poppler\n" +
      "  Debian:   sudo apt install poppler-utils\n" +
      "If this PDF's pages are vector drawings rather than scans, it has no picture of text to read " +
      "and OCR is not the right tool for it.",
  };
}

module.exports = { rasterize, DPI, MAX_PAGES };
