// Renders "page 1" of virtually any document format to a PNG via
// LibreOffice headless -- one well-tested conversion engine handles PDF,
// DOCX, XLSX, PPTX, legacy DOC/XLS/PPT, RTF, ODT/ODS/ODP, TXT/CSV, and even
// SVG. Converting SVG through this path also closes a real XSS door: the
// output is a flat raster PNG, so an embedded <script> in an uploaded SVG
// can never execute the way it could if the raw SVG were served inline to
// a browser.
//
// This intentionally replaces an earlier attempt at rendering PDFs
// in-process via pdfjs-dist + @napi-rs/canvas: that combination hit a
// real, reproducible font-glyph-path failure ("Requesting object that
// isn't resolved yet") in pdfjs's Node font loading with no clean fix.
// LibreOffice conversion was verified end-to-end against real
// .pdf/.docx/.xlsx/.txt/.svg fixtures, including concurrent invocations,
// and just works -- at the cost of requiring LibreOffice to be installed
// on the machine running the backend. When it isn't installed, this fails
// with a clear, actionable error instead of pretending to succeed; the
// Preview panel falls back to the extracted-text excerpt in that case.
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { execFile } = require("child_process");

const CONVERT_TIMEOUT_MS = 45_000;

class ThumbnailUnavailableError extends Error {}

let cachedSofficePath; // undefined = not probed yet, null = probed and not found

// Checked in order; the bare "soffice"/"soffice.exe" entries cover PATH on
// any OS (including Windows installs that added themselves to PATH), the
// rest are the well-known default install locations for the platforms
// this app's docs mention (Windows, macOS, Linux).
const CANDIDATE_PATHS = [
  "soffice",
  "soffice.exe",
  "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
  "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
  "/usr/bin/soffice",
  "/usr/local/bin/soffice",
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
];

function tryRun(candidate) {
  return new Promise((resolve) => {
    execFile(candidate, ["--version"], { timeout: 10_000 }, (err) => resolve(!err));
  });
}

/** Probes once per process and caches the result -- avoids spawning
 * "soffice --version" on every single preview request. */
async function findSofficeExecutable() {
  if (cachedSofficePath !== undefined) return cachedSofficePath;
  for (const candidate of CANDIDATE_PATHS) {
    // eslint-disable-next-line no-await-in-loop
    if (await tryRun(candidate)) {
      cachedSofficePath = candidate;
      return cachedSofficePath;
    }
  }
  cachedSofficePath = null;
  return null;
}

async function convertToPng(buffer, extension) {
  const soffice = await findSofficeExecutable();
  if (!soffice) {
    throw new ThumbnailUnavailableError(
      "LibreOffice isn't installed (or not found on PATH), so this file type can't be rendered as an image preview. " +
        "Install LibreOffice on the machine running the backend to enable this -- the text excerpt and download still work either way."
    );
  }

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "atlas-thumb-"));
  // Isolated profile per conversion -- headless soffice instances sharing
  // a profile directory can lock each other out under concurrent requests
  // (a well-known LibreOffice headless gotcha); this was verified to allow
  // genuinely concurrent conversions safely.
  const profileDir = path.join(workDir, "profile");
  const safeExt = (extension || "bin").replace(/[^a-z0-9]/gi, "") || "bin";
  const inputPath = path.join(workDir, `input.${safeExt}`);

  try {
    await fsp.writeFile(inputPath, buffer);

    // Must be a well-formed file:// URI, not a naive "file://" + path
    // concatenation -- on Windows that produced "file://C:\Users\..."
    // (backslashes, wrong slash count), which silently broke LibreOffice's
    // profile/temp setup and surfaced as an opaque "libpng error: Write
    // Error" from the PNG export filter rather than any obvious path
    // error. pathToFileURL handles the drive-letter/slash conversion
    // correctly on every platform.
    const profileUrl = pathToFileURL(profileDir).href;

    await new Promise((resolve, reject) => {
      execFile(
        soffice,
        [
          "--headless",
          "--norestore",
          `-env:UserInstallation=${profileUrl}`,
          "--convert-to",
          "png",
          "--outdir",
          workDir,
          inputPath,
        ],
        { timeout: CONVERT_TIMEOUT_MS },
        (err) => {
          if (err) reject(new ThumbnailUnavailableError(`LibreOffice conversion failed: ${err.message}`));
          else resolve();
        }
      );
    });

    const outputPath = path.join(workDir, "input.png");
    try {
      return await fsp.readFile(outputPath);
    } catch {
      throw new ThumbnailUnavailableError("LibreOffice ran but produced no output image (unsupported or corrupt file).");
    }
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { convertToPng, findSofficeExecutable, ThumbnailUnavailableError };
