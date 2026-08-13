const db = require("../config/database");
const { createBaseRepository } = require("./baseRepository");

const base = createBaseRepository("storage_locations", { defaultOrderBy: "name ASC" });

async function listActive() {
  const { rows } = await db.query(
    "SELECT * FROM storage_locations WHERE is_active = true ORDER BY name ASC"
  );
  return rows;
}

async function create({ name, type, rootPath, accessMode = "direct", config = {}, isReadOnly = true }) {
  const { rows } = await db.query(
    `INSERT INTO storage_locations (name, type, root_path, access_mode, config, is_read_only)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [name, type, rootPath, accessMode, config, isReadOnly]
  );
  return rows[0];
}

/** Toggle whether the app may rename/move files in this location. */
async function setReadOnly(id, isReadOnly) {
  const { rows } = await db.query(
    "UPDATE storage_locations SET is_read_only = $2, updated_at = now() WHERE id = $1 RETURNING *",
    [id, isReadOnly]
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
async function deactivate(id) {
  const { rows } = await db.query(
    "UPDATE storage_locations SET is_active = false, updated_at = now() WHERE id = $1 RETURNING *",
    [id]
  );
  return rows[0] || null;
}

/**
 * Find a location -- active OR deactivated -- already registered for this
 * exact root path.
 *
 * Deactivated rows are included on purpose: `remove()` only deactivates, so
 * without this a user who removes a folder and re-adds it gets a SECOND
 * location row for the same directory. The scan then finds no existing
 * `files` rows under the new location id and re-ingests everything, which
 * is how four files silently became eight.
 */
async function findByRootPath(rootPath) {
  const { rows } = await db.query(
    `SELECT * FROM storage_locations WHERE root_path = $1
     ORDER BY is_active DESC, created_at ASC LIMIT 1`,
    [rootPath]
  );
  return rows[0] || null;
}

async function reactivate(id, { name, type, accessMode, config } = {}) {
  const { rows } = await db.query(
    `UPDATE storage_locations SET
       is_active   = true,
       name        = COALESCE($2, name),
       type        = COALESCE($3, type),
       access_mode = COALESCE($4, access_mode),
       config      = COALESCE($5, config),
       updated_at  = now()
     WHERE id = $1 RETURNING *`,
    [id, name || null, type || null, accessMode || null, config || null]
  );
  return rows[0] || null;
}

// findManaged() lived here to serve storageLocationService.ensureManagedLocation,
// the auto-provisioned inbox for drag-and-drop uploads. Both are gone along
// with the upload routes themselves -- see routes/storageLocationRoutes.js for
// why that whole approach was removed. Nothing else ever queried type='managed'.

module.exports = {
  ...base, listActive, create, deactivate, findByRootPath, reactivate, setReadOnly,
};
