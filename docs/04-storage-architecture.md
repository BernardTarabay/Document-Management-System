# Phase 4 — Storage Architecture

## 4.1 Separation of concerns

Two independent stores, never conflated:

- **PostgreSQL** — identity, metadata, relationships, hashes, classification, audit.
  Never the file bytes themselves.
- **Physical Storage** — the actual bytes, at one or more Storage Locations, addressed
  by `(storage_location_id, current_path)`.

The backend is the only component allowed to write to PostgreSQL. The backend reaches
physical bytes either directly (if the Storage Location is on a filesystem it can mount)
or indirectly, through a Filesystem Agent, when it cannot.

## 4.2 Storage Location abstraction

Every place files live is a row in `storage_locations`:

```
storage_locations
  id
  name                  -- "Office NAS", "Abdo's Laptop"
  type                  -- local | nas | server | managed | cloud
  root_path             -- base path/prefix within that location
  access_mode           -- direct | agent   (does the backend reach it itself, or via an agent?)
  agent_id              -- FK -> filesystem_agents, nullable, required when access_mode = agent
  config                -- jsonb, backend-specific connection details (future: bucket, region, etc.)
  is_active
  created_at
```

`access_mode` is the pivot: a `direct` location (e.g., a server volume already mounted
next to the Node process, or in the future an S3 bucket reachable via SDK) is read/written
by a `StorageService` implementation directly. An `agent` location requires routing
every operation through an authenticated Filesystem Agent. Both cases share the exact
same `files.storage_location_id` foreign key and the exact same downstream
domain model — Files, Documents, Duplicate Groups, etc. don't know or care which kind of
location they live on. This is what lets storage evolve (local → NAS → cloud) without an
application rewrite, per the spec's explicit requirement.

## 4.3 Storage Service interface (implemented in Phase 10, contract fixed now)

```
StorageService
  readStream(fileId)              -> Readable
  writeStream(fileId, stream)     -> void         (only via reviewed operations, never raw upload)
  stat(fileId)                    -> { size, mtime, exists }
  move(fileId, newPath)           -> void          (goes through operation approval, see 4.5)
  rename(fileId, newName)         -> void
  delete(fileId)                  -> void          (archive-first; see safe deduplication)
  listDirectory(locationId, path) -> FileDescriptor[]   (used by scans)
```

Two concrete implementations, both now built: `LocalStorageService` (direct filesystem
access, used when the backend itself can reach the path — e.g., a server volume) and
`AgentStorageService` (Phase 12 — enqueues typed operations for a Filesystem Agent and
awaits its result). Both satisfy the same interface, so services/controllers above this
layer are written once against the interface, never against a concrete backend.

`getStorageServiceFor()` is the only place that branches on `access_mode`; every job
processor (`scan`, `hash`, `bulk_rename`, …) runs unchanged against either kind of
location. The one behavioural difference callers can observe is latency: an agent
operation costs up to one agent poll interval, because the backend cannot call the
agent and must wait for it to claim the work (see §4.5 below).

## 4.4 When is a Filesystem Agent necessary?

A Filesystem Agent is required precisely when the physical files live on a machine the
Express backend process cannot otherwise address — most commonly a user's personal
desktop/laptop that is not always online and is not exposed to the server's network.
It is *not* required when files live on a volume the backend host can mount directly
(attached server storage, a reachable NAS export, a future object-storage bucket via
SDK). The system supports a mix of both simultaneously; agent-ness is a per-
Storage-Location property, not a global mode.

## 4.5 Agent security model

```
filesystem_agents
  id
  storage_location_id     -- FK, the location this agent brokers
  name
  api_key_hash            -- bcrypt hash of a long random key issued at registration
  status                  -- online | offline
  last_seen_at
  registered_directories  -- jsonb, directories the agent has confirmed it may operate on
  created_at
```

Principles enforced at the backend, not trusted to the agent:

1. The agent authenticates to the backend (not the other way around) using its API key
   over TLS, and re-establishes a heartbeat/status channel.
2. The agent never receives arbitrary shell commands or arbitrary paths. It receives a
   specific, backend-issued **operation** (`move file X to path Y`, `rename file X`)
   referencing a `file_id` the backend already resolved to a real, known path.
3. The backend validates every requested path against the Storage Location's
   `root_path` and the agent's `registered_directories` before issuing an operation —
   path traversal (`../..`) is rejected server-side, never left to the agent to police.
4. The agent reports success/failure per operation; the backend records the result
   (`processing_job_items` / `audit_logs`), never assumes success.
5. A compromised or malicious agent can, at worst, misreport the state of directories it
   was already registered for — it cannot be used to pivot into arbitrary filesystem
   access because it never receives arbitrary commands, only typed, pre-validated
   operations tied to rows the backend already owns.

### As built (Phase 12)

The transport is a **poll**, not a callback: the backend writes a row into
`agent_operations` (migration 017) and the agent claims it on its next poll via
`UPDATE ... FOR UPDATE SKIP LOCKED`, so a given operation is handed out exactly once
even with concurrent polls. Claimed work that is never reported expires on a deadline,
so a laptop that sleeps mid-operation produces a clear 503 rather than a hang.

The six operation types are `list_directory`, `stat`, `read_file`, `rename`, `move`,
`remove` — the exact surface `StorageService` needs, and nothing else.

Authentication: a long random API key issued once at registration (bcrypt-hashed at
rest, never retrievable again) is exchanged for a 1-hour session token signed with
`AGENT_JWT_SECRET`. That secret is deliberately distinct from `JWT_ACCESS_SECRET` so an
agent token and a user token can never be presented for one another, and `revoked_at`
is re-checked on every request so revocation is immediate rather than waiting out a
token's lifetime.

Principle 3 is enforced **on both sides, independently**: `agentService.assertPathAllowed`
validates against the root and registered directories before dispatch, and the agent
re-validates locally in `desktop-agent/src/operations.js` before touching anything. The
duplication is the point — principle 5 says a compromised agent must not become
arbitrary filesystem access, and the symmetric requirement is that a compromised or
buggy backend must not either. Neither side trusts the other; both guards have their own
tests.

`registered_directories` uses segment-boundary matching, so registering `Finance` does
not authorize `Finance-Private` — the same off-by-one that a naive `startsWith` check
would allow, and that `resolveWithinRoot` already guards against for the root itself.

## 4.6 Reconciliation (sync state)

Because the filesystem can change outside the app (manual deletes, moves outside the
UI), every Storage Location supports a **Repository Scan** (Phase 6 background job) that
diffs actual directory listings against `files` rows and updates `files.status`
(`active | missing | moved | changed`) plus a `filesystem_scans` summary row. This is the
mechanism referenced in the spec's Reliability section — the database is never assumed
to be perpetually correct, only reconciled on a known cadence.

## 4.7 Multi-device access

Because the React client only ever talks to the Express API over HTTPS — never directly
to a Storage Location or Agent — any device (desktop, laptop, tablet, phone) gets the
same view and the same permission enforcement without needing filesystem access of its
own. Downloads/previews are streamed through the backend (`StorageService.readStream`),
so a phone can retrieve a file that physically lives on a NAS behind a desktop agent
without ever needing NAS credentials itself.
