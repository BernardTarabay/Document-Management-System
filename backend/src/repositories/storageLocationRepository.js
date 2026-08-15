// Storage location persistence.
//
// Every read here is scoped to an owner. A storage_locations row is an
// absolute path on somebody's disk plus the flags that decide whether this
// application may rename and move the real files under it -- the single most
// sensitive row in the schema. Handing one to the wrong account is not a
// privacy problem, it is a "this app now has write access to a stranger's
// documents" problem.
const db = require("../config/database");
const { createBaseRepository } = require("./baseRepository");
const { ownedRepository, requireOwner } = require("./ownership");

const base = createBaseRepository("storage_locations", { defaultOrderBy: "name ASC" });
const owned = ownedRepository(db, "storage_locations", { orderBy: "name ASC" });

/**
 * The user's active locations, each carrying the device it physically lives
 * on. The device join is LEFT rather than INNER because a location registered
 * before devices existed, or one whose device was deleted, must still be
 * listed -- a folder disappearing from the UI because of a missing join row
 * is exactly the kind of silent loss this app is supposed to avoid.
 */
async function listActive(ownerUserId) {
  requireOwner(ownerUserId, "storageLocations.listActive");
  const { rows } = await db.query(
    `SELECT sl.*,
            d.id     AS device_id,
            d.name   AS device_name,
            d.kind   AS device_kind,
            d.status AS device_status,
            d.last_seen_at AS device_last_seen_at
       FROM storage_locations sl
       LEFT JOIN devices d ON d.id = sl.device_id
      WHERE sl.is_active = true AND sl.owner_user_id = $1
      ORDER BY sl.name ASC`,
    [ownerUserId]
  );
  return rows;
}

async function create({
  ownerUserId, name, type, rootPath, accessMode = "direct",
  config = {}, isReadOnly = true, deviceId = null,
}) {
  requireOwner(ownerUserId, "storageLocations.create");
  const { rows } = await db.query(
    `INSERT INTO storage_locations
       (owner_user_id, name, type, root_path, access_mode, config, is_read_only, device_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [ownerUserId, name, type, rootPath, accessMode, config, isReadOnly, deviceId]
  );
  return rows[0];
}

/**
 * Editable settings.
 *
 * COALESCE-per-column so a PATCH carrying one field cannot blank the others,
 * and the owner is in the WHERE clause rather than checked beforehand -- an
 * UPDATE that matches zero rows is a safe no-op, whereas a check-then-update
 * has a window between the two.
 */
async function updateForOwner(id, ownerUserId, { name, isReadOnly, watchEnabled, autoApplyNaming, replicationEnabled } = {}) {
  requireOwner(ownerUserId, "storageLocations.updateForOwner");
  const { rows } = await db.query(
    `UPDATE storage_locations SET
       name                = COALESCE($3, name),
       is_read_only        = COALESCE($4, is_read_only),
       watch_enabled       = COALESCE($5, watch_enabled),
       auto_apply_naming   = COALESCE($6, auto_apply_naming),
       replication_enabled = COALESCE($7, replication_enabled),
       updated_at          = now()
     WHERE id = $1 AND owner_user_id = $2
     RETURNING *`,
    [
      id, ownerUserId,
      name ?? null,
      isReadOnly === undefined ? null : Boolean(isReadOnly),
      watchEnabled === undefined ? null : Boolean(watchEnabled),
      autoApplyNaming === undefined ? null : Boolean(autoApplyNaming),
      replicationEnabled === undefined ? null : Boolean(replicationEnabled),
    ]
  );
  return rows[0] || null;
}

/**
 * Soft-delete/deactivate (is_active = false). Not a hard DELETE: files
 * already ingested from this location reference it via
 * files.storage_location_id (ON DELETE RESTRICT -- see 004_files.sql), and
 * per the schema's own design notes, history here is additive, not
 * destructive. Deactivating just removes it from listActive() (what the
 * UI shows) and blocks new scans; nothing already ingested is touched.
 */
async function deactivate(id, ownerUserId) {
  requireOwner(ownerUserId, "storageLocations.deactivate");
  const { rows } = await db.query(
    `UPDATE storage_locations SET is_active = false, updated_at = now()
      WHERE id = $1 AND owner_user_id = $2 RETURNING *`,
    [id, ownerUserId]
  );
  return rows[0] || null;
}

/**
 * Find a location -- active OR deactivated -- already registered for this
 * exact root path BY THIS USER.
 *
 * Deactivated rows are included on purpose: `remove()` only deactivates, so
 * without this a user who removes a folder and re-adds it gets a SECOND
 * location row for the same directory. The scan then finds no existing
 * `files` rows under the new location id and re-ingests everything, which
 * is how four files silently became eight.
 *
 * Scoped to the owner because two accounts pointing at the same path is
 * legitimate -- on a shared machine, C:\Users\Public\Docs is one folder and
 * two people may each want it indexed into their own archive. Matching
 * globally would have handed the second registrant the first one's location
 * row, and with it every file already ingested under it.
 */
async function findByRootPath(rootPath, ownerUserId) {
  requireOwner(ownerUserId, "storageLocations.findByRootPath");
  const { rows } = await db.query(
    `SELECT * FROM storage_locations
      WHERE root_path = $1 AND owner_user_id = $2
      ORDER BY is_active DESC, created_at ASC LIMIT 1`,
    [rootPath, ownerUserId]
  );
  return rows[0] || null;
}

async function reactivate(id, ownerUserId, { name, type, accessMode, config } = {}) {
  requireOwner(ownerUserId, "storageLocations.reactivate");
  const { rows } = await db.query(
    `UPDATE storage_locations SET
       is_active   = true,
       name        = COALESCE($3, name),
       type        = COALESCE($4, type),
       access_mode = COALESCE($5, access_mode),
       config      = COALESCE($6, config),
       updated_at  = now()
     WHERE id = $1 AND owner_user_id = $2 RETURNING *`,
    [id, ownerUserId, name || null, type || null, accessMode || null, config || null]
  );
  return rows[0] || null;
}

/**
 * Every active location across all accounts.
 *
 * The ONE legitimately unscoped read, and it exists for the background
 * watcher (jobs/storageWatcher.js), which runs on a timer with no user in
 * context and must watch every registered folder regardless of who owns it.
 * Named to make that obvious at the call site: anything reaching for
 * "AllOwners" in a request handler is a bug.
 */
async function listActiveAllOwners() {
  const { rows } = await db.query(
    "SELECT * FROM storage_locations WHERE is_active = true ORDER BY owner_user_id, name ASC"
  );
  return rows;
}

module.exports = {
  ...base,
  ...owned,
  listActive,
  listActiveAllOwners,
  create,
  updateForOwner,
  deactivate,
  findByRootPath,
  reactivate,
};
