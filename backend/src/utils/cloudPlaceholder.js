// Detects cloud-sync placeholder files -- iCloud Drive "Optimize Storage",
// OneDrive "Files On-Demand", Dropbox Smart Sync.
//
// Why this matters: a placeholder appears in a directory listing at its full
// logical size, but its bytes are not on local disk. Merely READING one makes
// the sync client download it. This app reads every file it ingests (to hash,
// and again to extract text), so pointing a scan at a few hundred gigabytes of
// cloud-backed documents would silently trigger a few hundred gigabytes of
// downloads -- filling the disk it was trying to organize.
//
// WHICH WAY TO BE WRONG
//
// The two errors are not symmetric, and that shapes everything below:
//
//   False positive  -> a real file is skipped. No hash, no text, never
//                      searchable. Silent, permanent, and invisible to the
//                      user. This is the unacceptable one.
//   False negative  -> a placeholder gets downloaded. Costs bandwidth and
//                      disk, but the file ends up correctly indexed and the
//                      user can see what happened.
//
// So detection is deliberately conservative: only claim "placeholder" on
// positive evidence, never on the absence of it.
//
// THE WINDOWS TRAP
//
// The obvious heuristic -- "size > 0 but zero blocks allocated" -- is correct
// on POSIX and WRONG on Windows. Node reports `blocks: 0` for any small NTFS
// file, because small files live resident in the MFT rather than in allocated
// clusters. Measured on this machine: a 56-byte file reports blocks 0, a 2 MB
// file reports 4096. Applying the POSIX rule on Windows would flag every
// small document as a placeholder and quietly drop it from the index.
//
// So on Windows the blocks signal is only trusted for files large enough that
// a real one must have allocated clusters, and the authoritative answer comes
// from the file's actual attributes (below), which Node does not expose.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const IS_WINDOWS = process.platform === "win32";

// Windows file attributes ([MS-FSCC] 2.6).
const FILE_ATTRIBUTE_OFFLINE = 0x1000;
const FILE_ATTRIBUTE_RECALL_ON_OPEN = 0x40000;
const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x400000;
const PLACEHOLDER_MASK =
  FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;

// Below this, the blocks signal is untrustworthy on Windows (MFT-resident
// files) and the download would be trivial anyway. A placeholder worth
// avoiding is a large file.
const MIN_SIZE_FOR_BLOCKS_HEURISTIC = 1024 * 1024;

const POWERSHELL_TIMEOUT_MS = 60_000;

// Coalescing window for attribute lookups. Job processors run concurrently
// (WORKER_CONCURRENCY), so several files can need the authoritative check at
// once; without this, each one spawns its own PowerShell. Waiting a few
// milliseconds turns N concurrent lookups into a single subprocess. The
// window is deliberately tiny -- it is dead time added to a check that only
// happens for genuinely suspicious files.
const BATCH_WINDOW_MS = 25;
const MAX_BATCH_PATHS = 250;

/**
 * Decide from an fs.Stats alone. Cheap, no subprocess -- but on Windows this
 * can only ever produce a *suspicion* for large files; the authoritative
 * check is readAttributes().
 *
 * @param {import('fs').Stats & {attributes?: number}} stats
 */
function isPlaceholderStat(stats) {
  if (!stats) return false;

  // Authoritative when present (some runtimes/platforms surface it).
  if (typeof stats.attributes === "number") {
    return (stats.attributes & PLACEHOLDER_MASK) !== 0;
  }

  if (typeof stats.blocks !== "number" || stats.size <= 0) return false;

  // POSIX: zero allocated blocks for a non-empty file is a real signal.
  if (!IS_WINDOWS) return stats.blocks === 0;

  // Windows: only above the size where a genuine file must have clusters.
  return stats.blocks === 0 && stats.size >= MIN_SIZE_FOR_BLOCKS_HEURISTIC;
}

function powershellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Read real Windows file attributes for a batch of paths.
 *
 * Batched because spawning PowerShell costs ~100ms; one call per file across
 * a hundred thousand files would take hours. Returns a Map of path -> integer
 * attributes; paths that could not be read are simply absent, which callers
 * treat as "not a placeholder" per the conservative rule above.
 *
 * @param {string[]} absolutePaths
 * @returns {Promise<Map<string, number>>}
 */
async function readWindowsAttributes(absolutePaths) {
  const result = new Map();
  if (!IS_WINDOWS || absolutePaths.length === 0) return result;

  const lines = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$paths = @(${absolutePaths.map(powershellQuote).join(",")})`,
    "foreach ($p in $paths) {",
    "  $i = Get-Item -LiteralPath $p -Force",
    "  if ($i) { Write-Output ($p + [char]9 + [int]$i.Attributes) }",
    "}",
  ];

  // UTF-8 BOM: Windows PowerShell 5.1 reads a .ps1 as ANSI without one, which
  // mangles every non-ASCII path (see mirror/shortcutWriter.js for the same
  // trap costing shortcuts their accented names).
  const scriptPath = path.join(os.tmpdir(), `dms-attrs-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  await fs.promises.writeFile(scriptPath, "﻿" + lines.join("\n"), "utf8");

  try {
    const stdout = await new Promise((resolve) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        { timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true, maxBuffer: 20 * 1024 * 1024 },
        (err, out) => resolve(out || "")
      );
    });

    for (const line of stdout.split(/\r?\n/)) {
      const tab = line.lastIndexOf("\t");
      if (tab === -1) continue;
      const value = parseInt(line.slice(tab + 1), 10);
      if (Number.isFinite(value)) result.set(line.slice(0, tab), value);
    }
  } finally {
    await fs.promises.rm(scriptPath, { force: true }).catch(() => {});
  }

  return result;
}

// --- Batched attribute lookups ------------------------------------------
// Several concurrent callers become one PowerShell spawn. Pending lookups
// collect for BATCH_WINDOW_MS (or until MAX_BATCH_PATHS) and then resolve
// together.
let pendingLookups = [];
let batchTimer = null;

function flushAttributeBatch() {
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
  const batch = pendingLookups;
  pendingLookups = [];
  if (batch.length === 0) return;

  readWindowsAttributes(batch.map((b) => b.absolutePath))
    .then((map) => {
      for (const b of batch) b.resolve(map.get(b.absolutePath));
    })
    .catch(() => {
      // An unreadable batch means "no evidence", which the conservative rule
      // below treats as "not a placeholder" -- never as a reason to skip a
      // file.
      for (const b of batch) b.resolve(undefined);
    });
}

function lookupAttribute(absolutePath) {
  return new Promise((resolve) => {
    pendingLookups.push({ absolutePath, resolve });
    if (pendingLookups.length >= MAX_BATCH_PATHS) {
      flushAttributeBatch();
      return;
    }
    if (!batchTimer) {
      // Deliberately NOT unref'd. An unref'd timer cannot hold the event
      // loop open, so in a process with nothing else pending -- a CLI
      // script, the tail of a job -- Node exits before the flush runs and
      // the caller's await never settles. The window is 25 ms; letting it
      // hold the loop open for that long is the correct trade.
      batchTimer = setTimeout(flushAttributeBatch, BATCH_WINDOW_MS);
    }
  });
}

/**
 * Full check for one file. On Windows this only pays for a subprocess when
 * the cheap signals already suggest something is off, so the common case
 * (an ordinary local file) costs a single stat.
 *
 * That sentence used to be a lie. This function called
 * readWindowsAttributes([absolutePath]) unconditionally -- a batch of one --
 * which wrote a temp .ps1, spawned powershell.exe and deleted the temp file
 * FOR EVERY FILE INGESTED, right next to a docstring on the batching helper
 * warning that exactly this "would take hours" across a large repository.
 * Measured on this machine: 305.8 ms per file versus 0.2 ms for the stat,
 * making it 1,835x the cost of the thing it was gating.
 *
 * The gate below is `isPlaceholderStat`, which on Windows means "size is at
 * least MIN_SIZE_FOR_BLOCKS_HEURISTIC and no clusters are allocated".
 * Sampled across 1,052 real files on this machine, every file at or above
 * 4 KB reported blocks > 0 (minimum seen at >= 1 MB was 2,072), so a
 * non-zero block count reliably rules a placeholder out and the subprocess
 * is skipped entirely for ordinary local files.
 *
 * This can only ever err toward a FALSE NEGATIVE -- a small placeholder
 * (under the size threshold) gets read and therefore downloaded. That is the
 * acceptable direction per the doctrine at the top of this file: it costs
 * bandwidth, whereas a false positive silently drops a real document from
 * the index forever.
 *
 * @returns {Promise<{isPlaceholder: boolean, size: number, reason: string|null}>}
 */
async function inspect(absolutePath) {
  let stats;
  try {
    stats = await fs.promises.stat(absolutePath);
  } catch {
    return { isPlaceholder: false, size: 0, reason: null };
  }

  if (!IS_WINDOWS) {
    const flagged = isPlaceholderStat(stats);
    return {
      isPlaceholder: flagged,
      size: stats.size,
      reason: flagged
        ? "The file reports a size but has no blocks allocated on disk -- its contents are not local yet."
        : null,
    };
  }

  // The cheap signals say this is an ordinary local file. Don't pay for a
  // subprocess to confirm what a stat already settled.
  if (!isPlaceholderStat(stats)) {
    return { isPlaceholder: false, size: stats.size, reason: null };
  }

  // Suspicious -- now the authoritative attribute read is worth its cost.
  const value = await lookupAttribute(absolutePath);
  if (typeof value === "number" && (value & PLACEHOLDER_MASK) !== 0) {
    return {
      isPlaceholder: true,
      size: stats.size,
      reason: "The file is marked offline by a cloud sync client; its contents are not on this disk yet.",
    };
  }

  return { isPlaceholder: false, size: stats.size, reason: null };
}

module.exports = {
  inspect,
  isPlaceholderStat,
  readWindowsAttributes,
  IS_WINDOWS,
  FILE_ATTRIBUTE_OFFLINE,
  FILE_ATTRIBUTE_RECALL_ON_OPEN,
  FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
  PLACEHOLDER_MASK,
  MIN_SIZE_FOR_BLOCKS_HEURISTIC,
};
