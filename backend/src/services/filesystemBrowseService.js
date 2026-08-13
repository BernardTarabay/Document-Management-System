// Server-side folder picker for registering a storage location.
//
// Hand-typing an absolute path is error-prone (normalizeRootPath() exists
// purely to patch around Windows "Copy as path" quoting), so this lets an
// admin click through the backend's own filesystem instead.
//
// Deliberately not sandboxed to a fixed root: this route is gated behind the
// same "user.manage" permission as creating a storage location, and the
// backend can only ever see what it can see -- registering that same path
// would grant identical access. It returns directory NAMES only, never file
// contents.
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const { ValidationError } = require("../validators/validationError");

const IS_WINDOWS = process.platform === "win32";

/**
 * Where a user's Desktop actually is.
 *
 * On a machine with OneDrive folder redirection -- extremely common, and the
 * case on this one -- C:\Users\<name>\Desktop does not exist at all; the real
 * Desktop is C:\Users\<name>\OneDrive\Desktop. Starting the picker at the
 * home folder therefore shows 30-odd entries (3D Objects, NetHood, Tracing,
 * ...) with no Desktop among them, and the user has no way to guess they
 * need to go via OneDrive. Resolving it properly is the difference between
 * the picker being usable and not.
 */
function resolveKnownFolder(name) {
  const candidates = [];
  if (process.env.OneDrive) candidates.push(path.join(process.env.OneDrive, name));
  if (process.env.OneDriveCommercial) candidates.push(path.join(process.env.OneDriveCommercial, name));
  candidates.push(path.join(os.homedir(), name));
  return candidates.find((c) => {
    try {
      return fs.statSync(c).isDirectory();
    } catch {
      return false;
    }
  }) || null;
}

/** Drive roots (Windows) or common mount points (POSIX) that exist. */
function listDrives() {
  const drives = [];
  if (IS_WINDOWS) {
    for (let code = 65; code <= 90; code += 1) {
      const root = `${String.fromCharCode(code)}:\\`;
      try {
        fs.accessSync(root);
        drives.push({ name: root, path: root });
      } catch {
        // Drive letter not mounted -- an unplugged external is normal.
      }
    }
    return drives;
  }

  for (const root of ["/", "/Volumes", "/mnt", "/media"]) {
    try {
      if (fs.statSync(root).isDirectory()) drives.push({ name: root, path: root });
    } catch { /* not present */ }
  }
  return drives;
}

/**
 * The shortcuts shown down the side of the picker. These are the places
 * documents actually live; everything else is reachable by clicking.
 */
function quickAccess() {
  const entries = [];
  const add = (label, target) => {
    if (target && !entries.some((e) => e.path === target)) entries.push({ label, path: target });
  };

  add("Desktop", resolveKnownFolder("Desktop"));
  add("Documents", resolveKnownFolder("Documents"));
  add("Downloads", resolveKnownFolder("Downloads"));
  add("Pictures", resolveKnownFolder("Pictures"));

  // The OneDrive root itself, so cloud-synced folders outside Desktop and
  // Documents are one click away.
  if (process.env.OneDrive) add("OneDrive", process.env.OneDrive);
  if (process.env.OneDriveCommercial) add("OneDrive (work)", process.env.OneDriveCommercial);

  add("Home", os.homedir());
  return entries;
}

/**
 * Default landing spot. The Desktop is where people keep the folder they are
 * about to register far more often than the home directory is.
 */
function defaultStartPath() {
  return resolveKnownFolder("Desktop") || os.homedir();
}

async function listDirectories(rawTargetPath) {
  const resolved = rawTargetPath ? path.resolve(String(rawTargetPath).trim()) : defaultStartPath();

  let stat;
  try {
    stat = await fsp.stat(resolved);
  } catch {
    throw new ValidationError(`Path does not exist or is not accessible: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new ValidationError(`Not a directory: ${resolved}`);
  }

  let entries;
  try {
    entries = await fsp.readdir(resolved, { withFileTypes: true });
  } catch (err) {
    throw new ValidationError(`Cannot list directory (${err.code || err.message}): ${resolved}`);
  }

  const directories = [];
  let fileCount = 0;

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // dotfiles/dirs -- noise here

    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      // Mounted shares/NAS volumes are frequently symlinks -- resolve rather
      // than silently dropping them from the picker.
      try {
        isDir = (await fsp.stat(path.join(resolved, entry.name))).isDirectory();
      } catch {
        continue; // broken symlink
      }
    }

    if (isDir) directories.push(entry.name);
    else if (entry.isFile()) fileCount += 1;
  }

  directories.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  const parentPath = path.dirname(resolved);
  const parent = parentPath !== resolved ? parentPath : null;

  return {
    path: resolved,
    parent,
    // Surfaced so the picker can say "12 files here" -- registering a folder
    // that turns out to be empty is a confusing way to find out it was the
    // wrong one.
    fileCount,
    directories: directories.map((name) => ({ name, path: path.join(resolved, name) })),
    quickAccess: quickAccess(),
    drives: listDrives(),
  };
}

module.exports = { listDirectories, quickAccess, listDrives, defaultStartPath, resolveKnownFolder };
