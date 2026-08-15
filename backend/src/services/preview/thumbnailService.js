// Orchestrates "a picture of the first page, for any file" (Files page
// Preview button, and the preview pane embedded in the Edit modal so
// there's something to look at while manually renaming). Actual raster
// images already ARE a picture of themselves -- passed straight through,
// no conversion. Everything else goes through LibreOffice (see
// libreOfficeThumbnail.js) and gets cached on disk, keyed by content hash
// when known (so a rename/move doesn't invalidate the cache) or file id
// otherwise, so re-opening a preview doesn't re-run a whole LibreOffice
// conversion every time.
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { streamToBuffer } = require("../../utils/streamToBuffer");
const { convertToPng } = require("./libreOfficeThumbnail");
const imageDetection = require("../imageDetection");
const { guessMimeType } = require("../../utils/mimeGuess");

const THUMBNAIL_CACHE_DIR = path.resolve(process.env.THUMBNAIL_CACHE_DIR || "./storage/thumbnails");

const RASTER_IMAGE_MIME_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp",
]);

function cachePath(file) {
  const key = file.sha256_hash || file.id;
  return path.join(THUMBNAIL_CACHE_DIR, `${key}.png`);
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<{buffer: Buffer, contentType: string}>}
 */
async function getThumbnail(file, mimeType, storageService) {
  // A picture is served as itself. Two independent tests, deliberately:
  //
  //   1. the mime type, when it is a real raster type
  //   2. imageDetection, which is the single source of truth for "is this file
  //      a picture" and is what `files.is_image` and the Photos page use
  //
  // The second exists because the first silently failed for every photograph
  // in the corpus: with no image magic-numbers in fileSignature, a JPEG was
  // typed "unknown/jpeg", missed this set, and fell through to the LibreOffice
  // branch below -- which is for rendering DOCUMENTS to a picture, is not
  // installed here, and could not have rasterised a JPEG regardless. Every
  // photo showed "No preview available".
  //
  // fileSignature and mimeGuess are both fixed, so test 1 now passes on its
  // own. Test 2 stays as the backstop: the failure mode is a page that shows
  // nothing, and it is worth two cheap checks to never repeat it.
  if (RASTER_IMAGE_MIME_TYPES.has(mimeType) || imageDetection.isImage(file)) {
    const buffer = await streamToBuffer(storageService.readStream(file.current_path));
    return {
      buffer,
      // Never hand back "unknown/jpeg" -- the browser would download it
      // instead of rendering it. Fall back to the extension's real type.
      contentType: RASTER_IMAGE_MIME_TYPES.has(mimeType)
        ? mimeType
        : guessMimeType(file.extension, null),
    };
  }

  const cached = cachePath(file);
  if (await exists(cached)) {
    return { buffer: await fsp.readFile(cached), contentType: "image/png" };
  }

  const buffer = await streamToBuffer(storageService.readStream(file.current_path));
  const png = await convertToPng(buffer, file.extension);

  await fsp.mkdir(THUMBNAIL_CACHE_DIR, { recursive: true }).catch(() => {});
  await fsp.writeFile(cached, png).catch(() => {}); // cache is best-effort, never fails the request

  return { buffer: png, contentType: "image/png" };
}

module.exports = { getThumbnail };
