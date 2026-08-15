// Devices, and an honest answer to "can I open this file right now?".
//
// WHAT IS AND IS NOT TRUE TODAY
//
// Organization is already cross-device and always has been: names, subjects,
// classifications and duplicate groups live in Postgres, so signing in from a
// second computer shows the same organized archive. That half needs no work
// and this service does not pretend otherwise.
//
// CONTENT is the half that does not cross devices, because this application
// indexes files where they lie and copies nothing. A document discovered in
// C:\Scans on a desktop has no bytes reachable from a laptop unless the
// desktop is awake and its agent is connected.
//
// So availability is REPORTED rather than assumed. `availabilityFor` says
// which device holds a file, whether that device is answering, and therefore
// whether the bytes can be fetched at this moment. Where they cannot, the UI
// says "Desktop-A is offline" instead of offering a download that fails.
//
// NOT IMPLEMENTED, AND SAID SO
//
// Server-side replication -- the opt-in copy that would make a file readable
// while its origin machine is off -- has its schema (storage_locations
// .replication_enabled, the file_replicas table, the `replicate` job type)
// and no worker behind it. `replicationStatus` reports it as unavailable
// rather than showing a progress bar that would never move.
const deviceRepository = require("../repositories/deviceRepository");
const storageLocationRepository = require("../repositories/storageLocationRepository");
const fileRepository = require("../repositories/fileRepository");
const auditLogRepository = require("../repositories/auditLogRepository");
const db = require("../config/database");
const { requireOwner } = require("../repositories/ownership");
const { ValidationError } = require("../validators/validationError");
const { StorageAccessMode } = require("../models/enums");

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
    this.publicMessage = message;
  }
}

/** Every machine this account has registered, with live status. */
async function list(ownerUserId) {
  requireOwner(ownerUserId, "deviceService.list");
  // Guarantees the server row exists, so a user who has never enrolled an
  // agent still sees the one device they definitely have.
  await deviceRepository.ensureServerDevice(ownerUserId);
  const devices = await deviceRepository.listForOwnerWithStatus(ownerUserId);

  return devices.map((d) => ({
    id: d.id,
    name: d.name,
    hostname: d.hostname,
    platform: d.platform,
    kind: d.kind,
    // The DERIVED status, not the stored one. A laptop closed mid-session
    // leaves 'online' in the table forever, and nothing would correct it --
    // so the UI would keep promising files are reachable from a machine that
    // stopped answering hours ago.
    status: d.live_status,
    lastSeenAt: d.last_seen_at,
    agentVersion: d.agent_version,
    locationCount: d.location_count,
    fileCount: d.file_count,
    agentCount: d.agent_count,
    isThisServer: d.kind === "server",
  }));
}

async function rename(deviceId, name, ownerUserId) {
  requireOwner(ownerUserId, "deviceService.rename");
  const trimmed = String(name || "").trim();
  if (!trimmed) throw new ValidationError("A device needs a name.");

  const existing = await deviceRepository.findByIdForOwner(deviceId, ownerUserId);
  if (!existing) throw new NotFoundError("Device not found.");

  const updated = await deviceRepository.rename(deviceId, ownerUserId, trimmed);

  await auditLogRepository.record({
    userId: ownerUserId,
    action: "device.renamed",
    entityType: "device",
    entityId: deviceId,
    previousState: { name: existing.name },
    newState: { name: trimmed },
    reason: "Renamed from the Devices page",
  });

  return updated;
}

/**
 * Where one file's bytes are, and whether they can be read right now.
 *
 * This is the function the requirement's "the user should be able to
 * understand where the canonical file exists / which devices have it /
 * whether it is synchronized" turns into. Every field is derived from a real
 * row -- nothing here is a placeholder.
 */
async function availabilityFor(fileId, ownerUserId) {
  const file = await fileRepository.findByIdForOwner(fileId, ownerUserId);
  if (!file) throw new NotFoundError("File not found.");

  const { rows: replicas } = await db.query(
    `SELECT r.*,
            d.id AS device_id, d.name AS device_name, d.kind AS device_kind,
            d.last_seen_at, d.status AS device_status
       FROM file_replicas r
       LEFT JOIN devices d ON d.id = r.device_id
      WHERE r.file_id = $1
      ORDER BY (r.device_id IS NULL) DESC, d.name ASC`,
    [fileId]
  );

  const copies = [];
  for (const r of replicas) {
    const online = r.device_id ? await deviceRepository.isOnline(r.device_id) : true;
    copies.push({
      deviceId: r.device_id,
      deviceName: r.device_id ? r.device_name : "This server",
      deviceKind: r.device_id ? r.device_kind : "server",
      state: r.state,
      // "Present" says the bytes were there last time we looked; "reachable"
      // says we can get them NOW. Conflating the two is what produces a
      // download button that fails.
      reachable: r.state === "present" && online,
      online,
      lastSeenAt: r.last_seen_at,
      verifiedAt: r.verified_at,
      sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
    });
  }

  const reachableNow = copies.some((c) => c.reachable);
  const offlineHolders = copies.filter((c) => c.state === "present" && !c.online).map((c) => c.deviceName);

  return {
    fileId,
    availableNow: reachableNow,
    copies,
    // A sentence the UI can show verbatim. Written here so the Files page,
    // the Photos workspace and the triage queue all explain an unreachable
    // file the same way.
    explanation: reachableNow
      ? `Available now from ${copies.find((c) => c.reachable).deviceName}.`
      : offlineHolders.length
        ? `This file is on ${offlineHolders.join(" and ")}, which ${offlineHolders.length === 1 ? "is" : "are"} not connected right now. ` +
          "Start Atlas on that machine, or turn on replication for its storage location so a copy is kept on the server."
        : "No device currently reports holding this file. Re-scan its storage location to find out where it went.",
  };
}

/**
 * Replication, and why the toggle is refused.
 *
 * The schema for opt-in server-side replication exists (migration 030) and
 * the worker does not. Rather than offer a switch that records an intent
 * nothing acts on -- which would look exactly like working sync until someone
 * noticed their laptop still could not open anything -- turning it on is
 * refused with the reason. The reporting side is real: `replicaCount` counts
 * actual rows.
 */
async function replicationStatus(ownerUserId) {
  requireOwner(ownerUserId, "deviceService.replicationStatus");
  const locations = await storageLocationRepository.listActive(ownerUserId);
  const { rows } = await db.query(
    `SELECT count(*)::int AS server_copies
       FROM file_replicas r
       JOIN files f ON f.id = r.file_id
      WHERE f.owner_user_id = $1 AND r.device_id IS NULL AND r.state = 'present'`,
    [ownerUserId]
  );

  return {
    implemented: false,
    serverCopies: rows[0].server_copies,
    reason:
      "Server-side replication is not implemented. Its schema exists (file_replicas, " +
      "storage_locations.replication_enabled, the 'replicate' job type) but no worker performs the " +
      "copy, so enabling it would record an intention nothing acts on. Files remain readable from " +
      "any device while the machine holding them is connected, via that machine's agent.",
    locations: locations.map((l) => ({
      id: l.id,
      name: l.name,
      deviceId: l.device_id,
      accessMode: l.access_mode,
      replicationEnabled: l.replication_enabled,
      // An agent-brokered location is already remotely readable while its
      // device is up; a direct one lives on the server and is always readable.
      remotelyReadable: l.access_mode === StorageAccessMode.AGENT || l.device_id === null,
    })),
  };
}

module.exports = { NotFoundError, list, rename, availabilityFor, replicationStatus };
