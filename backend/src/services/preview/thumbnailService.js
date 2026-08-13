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
  if (RASTER_IMAGE_MIME_TYPES.has(mimeType)) {
    const buffer = await streamToBuffer(storageService.readStream(file.current_path));
    return { buffer, contentType: mimeType };
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
