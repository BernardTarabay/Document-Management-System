# Filesystem Agent (Phase 12)

An Electron desktop app that brokers file operations for a Storage Location
the backend cannot reach directly — typically a personal laptop that is
behind NAT and not always online (docs/04-storage-architecture.md §4.4).

```
desktop-agent/
  src/
    main.js         Electron main process — window, tray, IPC, autostart
    preload.js      the ONLY renderer↔main bridge (5 explicit channels)
    config.js       credential/config persistence in Electron userData
    backendClient.js  raw-fetch client for the agent protocol
    agentRunner.js  poll → execute → report loop (no Electron dependency)
    operations.js   the six typed operations, and the local path guard
    renderer/       status + settings window (sandboxed, CSP-locked)
  tests/            node --test, no Electron needed
```

## Why the agent polls instead of being called

The backend can never open a connection *to* this machine — that is the
entire reason the agent exists. So the direction is inverted: the backend
writes a typed operation into `agent_operations`, and the agent claims it on
its next poll, performs it, and reports the result back. `AgentStorageService`
on the backend hides all of that behind the same `StorageService` interface
`LocalStorageService` implements, so no job processor knows the difference.

The visible consequence is latency: an operation costs up to one poll
interval (default 5s). That is fine because nothing in the request path
calls these synchronously — the pipeline is queued stages by design
(docs/06 §6.2).

## Security model

The rules live in docs/04 §4.5. What matters in this directory:

- **The agent authenticates to the backend, never the reverse.** It holds a
  long random API key issued once at registration; the backend stores only
  its bcrypt hash. The key is exchanged for a 1-hour session token so the
  key itself is on the wire once per session.
- **The agent never receives a shell command or an arbitrary path** — only
  one of six typed operations (`list_directory`, `stat`, `read_file`,
  `rename`, `move`, `remove`).
- **Both sides validate every path, independently.** The backend checks
  against the Storage Location root and the agent's registered directories
  before dispatching (`agentService.assertPathAllowed`). The agent checks
  *again* locally before touching anything (`operations.js`). This is not
  redundancy to be refactored away: §4.5 requires that a compromised agent
  cannot become arbitrary filesystem access, and the symmetric requirement
  is that a compromised or buggy backend cannot either. Neither side trusts
  the other. Both are tested separately.
- **The renderer is fully sandboxed** — `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`, plus a CSP that forbids remote
  content. `preload.js` exposes five named channels and no generic
  `invoke(channel)` escape hatch.
- **Revocation is immediate.** `revoked_at` is re-checked on every request,
  not just at session open, so revoking does not wait for a token to expire.

### Where the API key is stored

Plaintext JSON in Electron's `userData` directory, mode `0600` — the same
posture as an SSH private key without a passphrase. The OS keychain would be
better and is the obvious upgrade; it needs a native module, deliberately
avoided here for the same reason the backend carries no vendor SDKs. Anyone
who can read that file is already running as the user whose files the agent
brokers.

## Setup

1. In the web app, create a Storage Location with **access mode `agent`**
   and the root path as it exists *on this machine*.
2. Register an agent for it (needs the `agent.manage` permission, which is
   Admin-only by seed — registering an agent mints a filesystem-brokering
   credential, so it is an administrative trust decision, not day-to-day
   document management):

   ```bash
   curl -X POST http://localhost:5000/api/agents \
     -H "Authorization: Bearer <admin token>" \
     -H "Content-Type: application/json" \
     -d '{"storageLocationId":"<id>","name":"Abdo'\''s Laptop"}'
   ```

   The response contains `apiKey` **once**. It is never retrievable again —
   only its bcrypt hash is stored.
3. Install and run the agent:

   ```bash
   cd desktop-agent
   npm install
   npm start
   ```

4. Enter the server URL, agent ID and API key, optionally restrict the
   registered directories, and click **Connect**. Closing the window leaves
   the agent running in the tray; it reconnects automatically on launch.

## Tests

```bash
npm test
```

16 tests covering the path guard and all six operations against a real temp
filesystem. They need neither Electron nor a running backend — which is why
`operations.js` and `agentRunner.js` have no Electron imports.

For the full loop against a live backend and database:

```bash
npm run verify:agent
```

(run from `backend/`) — creates a temp storage location and agent, starts a
real runner, exercises every operation through `AgentStorageService`,
asserts that traversal and out-of-scope paths are refused, then deletes
everything it created.

## Not built yet

- **No installer/packaging.** `npm start` runs it; there is no
  electron-builder config, no code signing, no auto-update.
- **No chunked transfer.** `read_file` returns the whole file base64-encoded
  in the operation result, capped at 64 MB. Fine for documents, wrong for
  media — a chunked upload channel would be needed for large binaries.
- **`AgentStorageService.readStream` resolves in the process that called
  it.** With several backend instances behind a load balancer this still
  works (the result is read back from Postgres, not held in memory), but the
  polling loop means throughput is bounded by poll interval, not bandwidth.
- **One agent per Storage Location.** `findActiveForStorageLocation` picks
  the most recently seen; multiple concurrent agents for one location are
  not load-balanced.
