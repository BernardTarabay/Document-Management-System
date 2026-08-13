// What a filename is allowed to be before this application will write it to
// a real filesystem.
//
// pathSafety.js answers a different question -- "does this path escape the
// storage root" -- and answers it well. This file answers the one underneath
// it: given a name that stays inside the root, is it a name Windows will
// actually accept, and will it round-trip? A name can be perfectly contained
// and still be a data-integrity problem.
//
// The manual rename path (fileService.updateFile) checked for `\` and `/` and
// nothing else, which let through every case below. The AI naming path
// (namingService.sanitizeTitle) strips illegal characters but has no length
// bound, which is open task #46: canonical names long enough to push a mirror
// shortcut past MAX_PATH, where WScript.Shell fails with "Value does not fall
// within the expected range".
const path = require("path");

/**
 * Reserved DOS device names. Still special in Win32 today: a file called
 * "NUL" or "CON.txt" cannot be created, and the failure is an opaque EINVAL
 * rather than anything that explains itself. Matched on the stem, because the
 * reservation applies with any extension.
 */
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

// <>:"|?* are outright illegal on Windows. Control characters are illegal
// everywhere that matters and are a classic way to smuggle something past a
// log or a UI. ':' additionally opens an NTFS alternate data stream --
// "report.pdf:hidden" writes to a stream on report.pdf rather than to a file
// of that name, so it is a containment issue as well as a legality one.
// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARACTERS = /[<>:"|?*\u0000-\u001f]/;

/**
 * Cap for a single filename.
 *
 * Windows' per-component limit is 255, but the binding constraint here is
 * MAX_PATH (260) applied to the whole path of the MIRROR shortcut, which is
 * mirrorRoot + subject folders + this name + ".lnk". 120 leaves room for a
 * deep-ish subject path under a normal mirror root while still being far
 * longer than any name a person would type.
 */
const MAX_FILENAME_LENGTH = 120;

class InvalidFilenameError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidFilenameError";
    this.statusCode = 400;
    this.publicMessage = message;
  }
}

/**
 * Throw unless `name` is a filename this app is willing to put on disk.
 * Returns the (trimmed) name so it can be used inline.
 */
function assertSafeFilename(rawName) {
  const name = String(rawName ?? "").trim();

  if (!name) throw new InvalidFilenameError("A filename cannot be empty.");

  if (/[\\/]/.test(name)) {
    throw new InvalidFilenameError("A filename cannot contain path separators.");
  }

  // "." and ".." contain no separator and so passed the old check, but
  // path.join resolves them to the directory itself and its parent. The
  // authoritative resolveWithinRoot would have caught the escape, but it
  // would have reported it as a traversal attempt rather than as what it is.
  if (name === "." || name === "..") {
    throw new InvalidFilenameError(`"${name}" is not a filename.`);
  }

  if (ILLEGAL_CHARACTERS.test(name)) {
    throw new InvalidFilenameError(
      'A filename cannot contain any of < > : " | ? * or control characters.'
    );
  }

  const stem = path.basename(name, path.extname(name));
  if (WINDOWS_RESERVED.test(stem)) {
    throw new InvalidFilenameError(
      `"${stem}" is a reserved device name on Windows and cannot be used as a filename.`
    );
  }

  // Windows silently strips these when creating the file, so the name on disk
  // would differ from the name recorded in the database -- and every
  // subsequent read would go looking for a file that is not there under that
  // spelling. Rejecting is better than storing a name we know is a lie.
  if (/[. ]$/.test(name)) {
    throw new InvalidFilenameError("A filename cannot end with a space or a dot.");
  }

  if (name.length > MAX_FILENAME_LENGTH) {
    throw new InvalidFilenameError(
      `A filename cannot be longer than ${MAX_FILENAME_LENGTH} characters (this one is ${name.length}).`
    );
  }

  return name;
}

/**
 * Shorten a generated name to fit, without damaging its extension.
 *
 * For names this application composes itself (namingService), where refusing
 * is not an option -- there is no user to tell. Truncates the stem and keeps
 * the extension, since the extension is what decides how the file opens.
 */
function capFilenameLength(name, max = MAX_FILENAME_LENGTH) {
  const value = String(name || "");
  if (value.length <= max) return value;

  const ext = path.extname(value);
  const stem = value.slice(0, value.length - ext.length);
  // If the extension alone is somehow longer than the cap, the name is too
  // strange to repair cleverly -- take a hard prefix.
  if (ext.length >= max) return value.slice(0, max);
  return stem.slice(0, max - ext.length).replace(/[. _-]+$/, "") + ext;
}

module.exports = {
  assertSafeFilename,
  capFilenameLength,
  InvalidFilenameError,
  MAX_FILENAME_LENGTH,
  WINDOWS_RESERVED,
};
