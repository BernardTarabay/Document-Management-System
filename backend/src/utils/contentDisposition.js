// RFC 6266 / RFC 5987 -safe Content-Disposition header builder.
//
// HTTP header VALUES are restricted to Latin-1 (Node's res.setHeader throws
// ERR_INVALID_CHAR for anything outside it). Our filenames are intentionally
// allowed to contain Arabic/Hebrew/French/etc. characters (see namingService
// sanitizeSegment -- we no longer strip non-ASCII), so any code that puts a
// filename straight into a Content-Disposition header can crash on those
// files. This builds both the legacy ASCII-only `filename="..."` fallback
// (for older clients) and the modern `filename*=UTF-8''...` extended form
// (RFC 5987) that lets browsers show the real, non-ASCII name.
function buildContentDisposition(type, filename) {
  const safeType = type === "inline" ? "inline" : "attachment";
  const rawName = String(filename || "file");

  // ASCII fallback: strip anything outside printable ASCII and quotes/backslashes.
  const asciiFallback = rawName
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .trim() || "file";

  const encoded = encodeURIComponent(rawName)
    // encodeURIComponent leaves a few chars that are still invalid inside a
    // quoted filename* value per RFC 5987 -- escape those too.
    .replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, "%2A");

  return `${safeType}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

module.exports = { buildContentDisposition };
