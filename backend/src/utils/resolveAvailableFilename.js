// Shared by bulkRenameProcessor.js (applying AI-approved proposals) and
// fileService.js (manual "Edit" rename) -- both need the exact same
// data-loss guard. Node's fs.rename() SILENTLY OVERWRITES an existing file
// at the destination (no error), so before either code path lands a file
// on a name, this checks whether something's already there and appends
// " (2)", " (3)", etc. until it finds a free name, same as an OS "Save As"
// dialog would. Extracted from bulkRenameProcessor.js so the two callers
// can't drift out of sync with each other.
const path = require("path");

async function resolveAvailableFilename(storageService, targetRelativeDir, desiredFilename) {
  const dir = targetRelativeDir || ".";
  const ext = path.extname(desiredFilename);
  const base = desiredFilename.slice(0, desiredFilename.length - ext.length);

  let candidate = desiredFilename;
  let attempt = 1;
  // Bounded loop -- a runaway collision chain shouldn't be possible, but
  // this refuses to spin forever if something is very wrong.
  while (attempt <= 500) {
    const candidateRelative = dir === "." ? candidate : path.join(dir, candidate);
    const stat = await storageService.stat(candidateRelative);
    if (!stat.exists) return candidate;
    attempt += 1;
    candidate = `${base} (${attempt})${ext}`;
  }
  throw new Error(`Could not find an available filename for "${desiredFilename}" after 500 attempts.`);
}

/**
 * Rename a file onto the first free name, and mean it.
 *
 * resolveAvailableFilename alone is advisory: it reports a name that was free
 * when it looked. LocalStorageService.rename now reserves its target with
 * O_EXCL and throws EEXIST rather than overwriting, which turns a lost race
 * from silent data loss into an error -- and this is the loop that then does
 * the obvious thing with that error: pick the next name and try again.
 *
 * Both callers (the manual Edit rename in fileService, and bulkRenameProcessor
 * applying approved proposals) go through here so they cannot drift apart,
 * which is the same reason resolveAvailableFilename was extracted originally.
 *
 * @returns {Promise<{absolutePath: string, filename: string}>}
 */
async function renameToAvailableName(storageService, currentPath, desiredFilename, targetRelativeDir = null) {
  let lastError = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const filename = await resolveAvailableFilename(storageService, targetRelativeDir, desiredFilename);
    try {
      const absolutePath = await storageService.rename(currentPath, filename, targetRelativeDir);
      return { absolutePath, filename };
    } catch (err) {
      // Somebody else took this name between choosing it and claiming it.
      // Any other failure is real and should surface immediately.
      if (err.code !== "EEXIST") throw err;
      lastError = err;
    }
  }

  throw lastError;
}

module.exports = { resolveAvailableFilename, renameToAvailableName };
