// Works out WHEN a document is from.
//
// WHY THIS IS NOT JUST mtime
//
// A filesystem timestamp records when the bytes last landed on this disk,
// which for a repository assembled from backups, copies and re-downloads is
// usually the day it was copied -- not the day the document is from. Sorting
// or filtering by that is close to sorting by accident. Every real format
// carries a better answer somewhere:
//
//   PDF     Info/CreationDate, as "D:20240315120000+02'00'"
//   OOXML   docProps/core.xml dcterms:created, ISO-8601
//   OLE     SummaryInformation PIDSI_CREATE_DTM, a Windows FILETIME
//   JPEG    EXIF DateTimeOriginal, as "2024:03:15 12:00:00"
//
// Each is a different shape and each has its own way of being wrong, so they
// are parsed explicitly rather than thrown at `new Date()` and hoped for.
// The filesystem time remains the fallback, but it is LABELLED as such, so
// the UI can be honest about which dates are real and a filter can prefer
// documents whose date actually means something.

// Anything outside this window is a parsing failure or a broken clock, not a
// document. Office files with an unset date famously report 1601 (the FILETIME
// epoch) and PDFs produced by bad tooling report 0000 or year 30827.
const EARLIEST = new Date("1900-01-01T00:00:00Z").getTime();
const LATEST_SKEW_MS = 366 * 24 * 60 * 60 * 1000; // a year ahead, for clock skew

function plausible(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const t = date.getTime();
  if (t < EARLIEST) return null;
  if (t > Date.now() + LATEST_SKEW_MS) return null;
  return date;
}

/**
 * PDF date strings: D:YYYYMMDDHHmmSSOHH'mm'
 * The offset is optional, and the apostrophes are part of the format.
 */
function parsePdfDate(value) {
  if (typeof value !== "string") return null;
  const m = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+-])?(\d{2})?'?(\d{2})?/.exec(value.trim());
  if (!m) return null;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", s = "00", sign, oh = "00", om = "00"] = m;

  let iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  if (sign === "Z" || !sign) iso += "Z";
  else iso += `${sign}${oh}:${om}`;
  return plausible(new Date(iso));
}

/** EXIF: "2024:03:15 12:00:00" -- colons in the date part, no timezone. */
function parseExifDate(value) {
  if (typeof value !== "string") return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  // No zone in EXIF; treated as UTC so the same file always yields the same
  // instant regardless of where it is indexed.
  return plausible(new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`));
}

/** ISO-8601, as OOXML core properties use. */
function parseIsoDate(value) {
  if (value instanceof Date) return plausible(value);
  if (typeof value !== "string" || !value.trim()) return null;
  return plausible(new Date(value.trim()));
}

/**
 * Windows FILETIME: 100-nanosecond ticks since 1601-01-01 UTC, as a BigInt or
 * a {low, high} pair. Zero means "never set", which is not the year 1601.
 */
function parseFileTime(ticks) {
  let big;
  try {
    big = typeof ticks === "bigint" ? ticks : BigInt(ticks);
  } catch {
    return null;
  }
  if (big <= 0n) return null;
  const msSinceEpoch = Number(big / 10000n) - 11644473600000;
  return plausible(new Date(msSinceEpoch));
}

/**
 * Pick the best available date for a file.
 *
 * Order is by trustworthiness, not convenience: a date the author's software
 * wrote into the document beats one the filesystem inferred. `created` beats
 * `modified` because "when is this document from" is asked of the document,
 * not of the last time somebody opened and re-saved it.
 *
 * @param {object} metadata  whatever the extractor produced
 * @param {{createdAtFs?: Date, modifiedAtFs?: Date}} fsTimes
 * @returns {{date: Date|null, source: string}}
 */
function resolveDocumentDate(metadata = {}, fsTimes = {}) {
  const m = metadata || {};

  const candidates = [
    ["exif", parseExifDate(m.dateTimeOriginal)],
    ["pdf", parsePdfDate(m.creationDate)],
    ["embedded", parseIsoDate(m.created)],
    ["ole", parseFileTime(m.createdFileTime)],
    ["embedded-modified", parseIsoDate(m.modified)],
    ["ole-modified", parseFileTime(m.modifiedFileTime)],
  ];

  for (const [source, date] of candidates) {
    if (date) return { date, source };
  }

  // Filesystem last. Prefer the OLDER of created/modified: a copy operation
  // updates one of them to "now", and the older survivor is more likely to
  // resemble the document's real age.
  const fsCandidates = [fsTimes.createdAtFs, fsTimes.modifiedAtFs]
    .map((d) => plausible(d instanceof Date ? d : d ? new Date(d) : null))
    .filter(Boolean)
    .sort((a, b) => a - b);

  if (fsCandidates.length) return { date: fsCandidates[0], source: "filesystem" };
  return { date: null, source: "none" };
}

module.exports = {
  resolveDocumentDate,
  parsePdfDate,
  parseExifDate,
  parseIsoDate,
  parseFileTime,
};
