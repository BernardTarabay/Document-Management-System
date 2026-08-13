// Real-time ingestion: notice a new or changed file in a watched storage
// location and ingest it without anyone pressing "Run scan".
//
// The person this is built for is not going to open the app, click Scan,
// wait, and approve a queue of proposals. He saves a file where he already
// saves files; a few seconds later it should be named, classified and
// findable. Everything else here follows from that.
//
// Built on fs.watch({recursive:true}) rather than a watcher library --
// same "platform over dependency" reasoning as the rest of this codebase.
// The honest limitation: recursive watching is native on Windows and macOS
// but NOT on Linux, where Node would have to walk and watch every
// subdirectory. Rather than pretend, Linux falls back to the periodic
// rescan below, which is the safety net on every platform anyway.
//
// The periodic rescan is not optional even where watching works. Events are
// missed whenever the machine sleeps, a drive is unplugged and reconnected,
// or a sync client writes in bulk. A watcher alone silently drifts; a
// watcher plus a scheduled sweep converges.
const fs = require("fs");
const path = require("path");

const storageLocationRepository = require("../repositories/storageLocationRepository");
const { enqueueJob } = require("../queues");
const { JobType } = require("../models/enums");
const env = require("../config/env");

const RECURSIVE_SUPPORTED = process.platform === "win32" || process.platform === "darwin";

// Directories that generate constant noise and never contain documents.
const IGNORED_SEGMENTS = new Set([
  "node_modules", ".git", ".svn", "$RECYCLE.BIN", "System Volume Information",
  ".Trash", ".Trashes", ".DS_Store", "__pycache__",
]);

// Sync clients and Office write temp files constantly; ingesting them
// produces garbage rows that vanish moments later.
const IGNORED_PATTERNS = [
  /^~\$/,           // Office lock files
  /\.tmp$/i,
  /\.crdownload$/i,
  /\.partial$/i,
  /^\.~lock\./,     // LibreOffice
  /\.swp$/i,
];

function shouldIgnore(relativePath) {
  if (!relativePath) return true;
  const segments = relativePath.split(/[/\\]/);
  if (segments.some((s) => IGNORED_SEGMENTS.has(s))) return true;
  const base = segments[segments.length - 1];
  return IGNORED_PATTERNS.some((re) => re.test(base));
}

class StorageWatcher {
  constructor() {
    this.watchers = new Map(); // locationId -> fs.FSWatcher
    this.pending = new Map();  // locationId -> timeout
    this.rescanTimer = null;
    this.started = false;
  }

  async start() {
    if (this.started || !env.watch.enabled) return;
    this.started = true;

    await this.refresh();

    // Re-read the location list periodically so a folder registered while
    // the server is running starts being watched without a restart, and a
    // removed one stops.
    this.rescanTimer = setInterval(() => {
      this.refresh().catch((err) => console.error("[watcher] refresh failed:", err.message));
      this.sweep().catch((err) => console.error("[watcher] periodic rescan failed:", err.message));
    }, Math.max(1, env.watch.rescanIntervalMinutes) * 60 * 1000);
    this.rescanTimer.unref();

    console.log(
      `[watcher] Started. Recursive watching ${RECURSIVE_SUPPORTED ? "enabled" : "UNAVAILABLE on this platform -- relying on the periodic rescan"}; ` +
      `rescan every ${env.watch.rescanIntervalMinutes} minute(s).`
    );
  }

  /** Sync the set of active watchers with the set of watched locations. */
  async refresh() {
    const locations = (await storageLocationRepository.listActive()).filter(
      (l) => l.watch_enabled && l.access_mode === "direct"
    );
    const wanted = new Set(locations.map((l) => l.id));

    for (const [id, watcher] of this.watchers) {
      if (!wanted.has(id)) {
        watcher.close();
        this.watchers.delete(id);
      }
    }

    if (!RECURSIVE_SUPPORTED) return;

    for (const location of locations) {
      if (this.watchers.has(location.id)) continue;
      try {
        const watcher = fs.watch(
          location.root_path,
          { recursive: true, persistent: false },
          (eventType, filename) => {
            if (filename && shouldIgnore(filename)) return;
            this.scheduleScan(location);
          }
        );
        // A watched drive being yanked emits an error; drop the watcher and
        // let refresh() re-establish it when the drive is back.
        watcher.on("error", (err) => {
          console.error(`[watcher] ${location.name}: ${err.message}`);
          watcher.close();
          this.watchers.delete(location.id);
        });
        this.watchers.set(location.id, watcher);
        console.log(`[watcher] Watching "${location.name}" (${location.root_path})`);
      } catch (err) {
        // An offline external drive is expected, not exceptional.
        console.warn(`[watcher] Could not watch "${location.name}": ${err.message}`);
      }
    }
  }

  /**
   * Coalesce a burst of events into one scan.
   *
   * Copying a folder in fires an event per file, and a large file fires
   * many while it is still being written. Debouncing means one scan after
   * things settle, rather than hundreds of scans over a half-written file.
   */
  scheduleScan(location) {
    if (this.pending.has(location.id)) clearTimeout(this.pending.get(location.id));
    const timer = setTimeout(() => {
      this.pending.delete(location.id);
      enqueueJob(JobType.SCAN, { storageLocationId: location.id }, { storageLocationId: location.id })
        .then(() => console.log(`[watcher] Change detected in "${location.name}" -- scan queued.`))
        .catch((err) => console.error(`[watcher] Could not queue scan for "${location.name}":`, err.message));
    }, env.watch.debounceMs);
    timer.unref();
    this.pending.set(location.id, timer);
  }

  /** The safety net: scan every watched location regardless of events. */
  async sweep() {
    const locations = (await storageLocationRepository.listActive()).filter(
      (l) => l.watch_enabled && l.access_mode === "direct"
    );
    for (const location of locations) {
      if (!fs.existsSync(location.root_path)) continue; // drive offline -- skip quietly
      await enqueueJob(JobType.SCAN, { storageLocationId: location.id }, { storageLocationId: location.id });
    }
    if (locations.length) console.log(`[watcher] Periodic rescan queued for ${locations.length} location(s).`);
  }

  stop() {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.rescanTimer = null;
    this.started = false;
    console.log("[watcher] Stopped.");
  }
}

const storageWatcher = new StorageWatcher();

module.exports = { storageWatcher, StorageWatcher, shouldIgnore, RECURSIVE_SUPPORTED };
