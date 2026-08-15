// Builds the organized mirror: a folder tree that looks like the Subjects
// taxonomy, where every entry is a shortcut to the real file wherever it
// actually lives.
//
// This is what makes the whole read-only design usable. The originals keep
// their messy names in their scattered folders and are never touched; this
// tree is where the canonical names and the subject structure become
// something you can open in Explorer. It is entirely derived state -- delete
// the whole thing and `sync_mirror` rebuilds it from the database.
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const fileRepository = require("../../repositories/fileRepository");
const env = require("../../config/env");
const { resolveWithinRoot } = require("../../utils/pathSafety");
const { requireOwner } = require("../../repositories/ownership");
const { writeShortcuts, shortcutNameFor } = require("./shortcutWriter");

// Batch size for shortcut writing. Large enough that PowerShell startup
// cost is amortized, small enough that one failure doesn't lose much work.
const BATCH_SIZE = 250;

/**
 * Where one user's mirror lives.
 *
 * MIRROR_ROOT is a single folder on the machine running the backend, and the
 * mirror is derived entirely from one account's files -- so with more than one
 * account, writing them all into the same directory would interleave two
 * people's document trees and let the prune pass of one delete the shortcuts
 * of the other. Each owner therefore gets a subfolder.
 *
 * The segment is the account's uuid, not its name or email: this is a real
 * directory somebody may open in Explorer, and a folder named after a
 * colleague's email address is a disclosure that serves no purpose. The
 * Storage Locations page shows the resolved path, so nobody has to guess
 * which folder is theirs.
 */
function mirrorRoot(ownerUserId) {
  if (!env.mirrorRoot) {
    throw new Error(
      "MIRROR_ROOT is not set -- required before the organized shortcut folder can be built. " +
      "Point it at somewhere convenient, e.g. a folder on the Desktop."
    );
  }
  const base = path.resolve(env.mirrorRoot);
  if (!ownerUserId) return base;
  // resolveWithinRoot is belt-and-braces: the id comes from a uuid column, so
  // it cannot contain a separator, but this path is built by concatenation
  // and that is the shape that later grows a traversal bug.
  return resolveWithinRoot(base, ownerUserId);
}

/** Strip characters Windows rejects in a path segment. */
function safeSegment(name) {
  return String(name || "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120); // NTFS caps a single component at 255; leave room for " (2).lnk"
}

/**
 * Where a file's shortcut belongs inside the mirror: its subject folder
 * path plus its canonical name. Files with no subject land in _Unsorted so
 * they are still reachable rather than silently absent.
 */
function mirrorRelativePathFor(file) {
  // mirror_relative_dir / mirror_filename rather than the canonical_* columns:
  // a file that was filed but never renamed (or whose rename was rejected)
  // belongs here too, under its real filename. See
  // fileRepository.listForMirror.
  const dir = (file.mirror_relative_dir || "")
    .split(/[/\\.]/)
    .map(safeSegment)
    .filter(Boolean);
  const folder = dir.length ? dir : ["_Unsorted"];
  return path.join(...folder, shortcutNameFor(safeSegment(file.mirror_filename)));
}

/** Absolute path of the real file this shortcut should point at. */
function targetPathFor(file) {
  return path.resolve(file.root_path, file.current_path);
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

/**
 * Two different files can legitimately produce the same canonical name --
 * "Invoice 2026.pdf" from two different sources. Suffix rather than let one
 * silently overwrite the other, which would make a file simply vanish from
 * the organized view.
 */
function disambiguate(relativePath, taken) {
  if (!taken.has(relativePath.toLowerCase())) {
    taken.add(relativePath.toLowerCase());
    return relativePath;
  }
  const dir = path.dirname(relativePath);
  const base = path.basename(relativePath);
  // Split on the FIRST dot after the name so "Report.pdf.lnk" becomes
  // "Report (2).pdf.lnk", not "Report.pdf (2).lnk".
  const firstDot = base.indexOf(".");
  const stem = firstDot === -1 ? base : base.slice(0, firstDot);
  const rest = firstDot === -1 ? "" : base.slice(firstDot);

  for (let n = 2; n < 1000; n += 1) {
    const candidate = path.join(dir, `${stem} (${n})${rest}`);
    if (!taken.has(candidate.toLowerCase())) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }
  throw new Error(`Could not find a free mirror name for "${relativePath}".`);
}

/**
 * Rebuild the mirror.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.prune] - remove shortcuts whose file no longer
 *   qualifies. Defaults true; the mirror is derived state, so anything not
 *   currently justified by the database does not belong in it.
 * @param {(progress: {processed: number, total: number}) => void} [opts.onProgress]
 */
async function sync({ ownerUserId, prune = true, onProgress = () => {} } = {}) {
  requireOwner(ownerUserId, "mirrorService.sync");
  const root = mirrorRoot(ownerUserId);
  await ensureDir(root);

  const summary = {
    mirrorRoot: root,
    candidates: 0,
    written: 0,
    skippedOffline: 0,
    pruned: 0,
    errors: [],
  };

  const taken = new Set();
  const expected = new Set();
  const pending = [];
  let processed = 0;

  // Paginated: a mirror over a few hundred thousand files must not pull
  // every row into memory at once.
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const page = await fileRepository.listForMirror(ownerUserId, { limit: PAGE, offset });
    if (page.length === 0) break;

    for (const file of page) {
      summary.candidates += 1;
      const target = targetPathFor(file);

      // An offline external drive or an unmounted share means the target
      // does not resolve right now. Skip rather than write a shortcut that
      // opens to an error -- and leave any existing one alone, since the
      // drive coming back should not require a full re-sync.
      if (!fs.existsSync(target)) {
        summary.skippedOffline += 1;
        continue;
      }

      let relative;
      try {
        relative = disambiguate(mirrorRelativePathFor(file), taken);
        // The canonical dir comes from subject names, which are user-editable
        // -- so it is untrusted input to path construction, exactly like a
        // storage location's relative paths.
        resolveWithinRoot(root, relative);
      } catch (err) {
        summary.errors.push({ fileId: file.id, message: err.message });
        continue;
      }

      expected.add(path.join(root, relative).toLowerCase());
      pending.push({ file, relative, target });

      if (pending.length >= BATCH_SIZE) {
        processed += await flush(pending, root, summary);
        onProgress({ processed, total: summary.candidates });
      }
    }

    if (page.length < PAGE) break;
  }

  if (pending.length) {
    processed += await flush(pending, root, summary);
    onProgress({ processed, total: summary.candidates });
  }

  if (prune) summary.pruned = await pruneStale(root, expected);

  return summary;
}

async function flush(pending, root, summary) {
  const batch = pending.splice(0, pending.length);

  // Create every needed directory first -- mkdir is cheap and doing it
  // inside the shortcut writer would mean a failure per file rather than
  // per directory.
  const dirs = new Set(batch.map((e) => path.dirname(path.join(root, e.relative))));
  for (const dir of dirs) await ensureDir(dir);

  const entries = batch.map((e) => ({
    shortcutPath: path.join(root, e.relative),
    targetPath: e.target,
    description: `${e.file.location_name} — ${e.file.current_path}`,
  }));

  const result = await writeShortcuts(entries);
  summary.written += result.written;
  summary.errors.push(...result.errors);

  const failed = new Set(result.errors.map((x) => String(x.shortcutPath).toLowerCase()));
  for (const e of batch) {
    const full = path.join(root, e.relative);
    if (failed.has(full.toLowerCase())) continue;
    await fileRepository.setMirrorPath(e.file.id, e.relative);
  }

  return batch.length;
}

/**
 * Delete shortcuts that no longer correspond to anything, and any directory
 * left empty afterwards. Only ever removes files inside MIRROR_ROOT, and
 * only ones with the shortcut extension -- if someone has put their own
 * documents in here, we do not touch them.
 */
async function pruneStale(root, expected) {
  const { SHORTCUT_EXTENSION, IS_WINDOWS } = require("./shortcutWriter");
  let pruned = 0;

  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        // Remove the directory if the walk emptied it.
        try {
          const remaining = await fsp.readdir(full);
          if (remaining.length === 0) await fsp.rmdir(full);
        } catch { /* not empty, or vanished */ }
        continue;
      }

      const isShortcut = IS_WINDOWS
        ? entry.name.toLowerCase().endsWith(SHORTCUT_EXTENSION)
        : entry.isSymbolicLink();
      if (!isShortcut) continue; // somebody's real file -- leave it

      if (!expected.has(full.toLowerCase())) {
        await fsp.rm(full, { force: true }).catch(() => {});
        pruned += 1;
      }
    }
  }

  await walk(root);
  return pruned;
}

module.exports = { sync, mirrorRoot, mirrorRelativePathFor, safeSegment, disambiguate };
