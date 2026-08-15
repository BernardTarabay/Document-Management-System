// Is this file a picture?
//
// WHY IT IS ONE FUNCTION AND NOT AN INLINE TEST
//
// Four places need this answer and they must all give the same one: the
// ingest pipeline (which routes images away from text extraction), the Photos
// workspace query, the triage queue (which must NOT list them), and the
// dashboard. When each re-derived it from a slightly different mime/extension
// test, an image could be a photo on one page and a broken document on
// another.
//
// The answer is written to `files.is_image` at ingest so every query reads one
// column rather than re-deriving it, and this module is the only thing that
// decides what goes in that column.
const path = require("path");

/**
 * Extensions that are pictures.
 *
 * Deliberately broader than what the OCR engine or the thumbnailer can read:
 * this decides "does this belong in Photos", and a HEIC the previewer cannot
 * render is still a photograph. Being listed with a "no preview available"
 * placeholder is correct; being filed as an unreadable *document* is not.
 */
const IMAGE_EXTENSIONS = new Set([
  "jpg", "jpeg", "jpe", "jfif",
  "png", "gif", "bmp", "webp",
  "tif", "tiff",
  "heic", "heif", "avif",
  "svg",
  // Camera raw. No previewer here reads them, but they are unambiguously
  // photographs and belong with the rest of somebody's pictures.
  "raw", "cr2", "cr3", "nef", "arw", "dng", "orf", "rw2", "raf", "sr2",
]);

/**
 * Video, which is neither a photo nor a document.
 *
 * Called out explicitly because the alternative is worse in both directions:
 * treated as a document it goes to triage as "unreadable" forever, and
 * treated as an image it lands in Photos where the viewer cannot show it.
 * Recognising it means the pipeline can stop early and say so.
 */
const VIDEO_EXTENSIONS = new Set([
  "mp4", "mov", "avi", "mkv", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "3gp",
]);

const AUDIO_EXTENSIONS = new Set([
  "mp3", "wav", "flac", "aac", "ogg", "m4a", "wma",
]);

function normalizeExtension(value) {
  if (!value) return "";
  return String(value).trim().toLowerCase().replace(/^\.+/, "");
}

/**
 * @param {object} file - a files row, or anything with extension/mime fields
 * @returns {boolean}
 */
function isImage(file) {
  const mime = String(file?.mime_type_detected || file?.mime_type_declared || "").toLowerCase();
  // The declared/detected mime wins when it is present and unambiguous --
  // fileSignature.js reads magic bytes, which beats a lying extension.
  if (mime.startsWith("image/")) return true;

  const ext = normalizeExtension(
    file?.extension || path.extname(file?.filename_current || file?.filename_original || "")
  );
  return IMAGE_EXTENSIONS.has(ext);
}

function isVideo(file) {
  const mime = String(file?.mime_type_detected || file?.mime_type_declared || "").toLowerCase();
  if (mime.startsWith("video/")) return true;
  const ext = normalizeExtension(
    file?.extension || path.extname(file?.filename_current || file?.filename_original || "")
  );
  return VIDEO_EXTENSIONS.has(ext);
}

function isAudio(file) {
  const mime = String(file?.mime_type_detected || file?.mime_type_declared || "").toLowerCase();
  if (mime.startsWith("audio/")) return true;
  const ext = normalizeExtension(
    file?.extension || path.extname(file?.filename_current || file?.filename_original || "")
  );
  return AUDIO_EXTENSIONS.has(ext);
}

/**
 * Which pipeline a file belongs in, decided once at ingest.
 *
 *   'image'  -> Photos workspace. OCR, never text extraction.
 *   'media'  -> audio/video. No text to extract and none to invent; it is
 *               indexed, listed and filable, and the pipeline stops there
 *               rather than parading it through triage as "unreadable".
 *   'document' -> the normal extract -> classify -> name pipeline.
 */
function routeFor(file) {
  if (isImage(file)) return "image";
  if (isVideo(file) || isAudio(file)) return "media";
  return "document";
}

module.exports = {
  IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS,
  isImage, isVideo, isAudio, routeFor, normalizeExtension,
};
