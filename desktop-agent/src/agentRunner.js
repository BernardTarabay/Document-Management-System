// The agent's main loop: authenticate, heartbeat, poll for operations,
// execute them, report results.
//
// Polling (rather than the backend calling in) is forced by the deployment
// shape, not a preference: the agent runs on a laptop behind NAT that is
// frequently asleep, so the backend can never initiate a connection to it
// (docs/04-storage-architecture.md §4.4).
//
// Extracted from main.js with no Electron dependency so it can be unit
// tested against a fake client and executor.
const { createExecutor } = require("./operations");

const DEFAULT_POLL_SECONDS = 5;
// Backoff ceiling when the server is unreachable. Without it, a laptop that
// wakes up on a plane retries every 5s for hours.
const MAX_BACKOFF_SECONDS = 120;

class AgentRunner {
  /**
   * @param {object} opts
   * @param {import('./backendClient').BackendClient} opts.client
   * @param {(event: {type: string, message?: string, detail?: any}) => void} [opts.onEvent]
   */
  constructor({ client, pollIntervalSeconds = DEFAULT_POLL_SECONDS, onEvent = () => {} }) {
    this.client = client;
    this.pollIntervalSeconds = pollIntervalSeconds;
    this.onEvent = onEvent;
    this.running = false;
    this.timer = null;
    this.consecutiveFailures = 0;
    this.stats = { operationsSucceeded: 0, operationsFailed: 0, lastPollAt: null, lastError: null };
  }

  _emit(type, message, detail) {
    this.onEvent({ type, message, detail });
  }

  async start(registeredDirectories = []) {
    if (this.running) return;
    this.running = true;
    this.registeredDirectories = registeredDirectories;

    const session = await this.client.ensureSession();
    if (!session) throw new Error("Failed to open an agent session.");

    const info = this.client.agentInfo;
    this.executor = createExecutor({
      rootPath: info.rootPath,
      registeredDirectories: registeredDirectories.length ? registeredDirectories : info.registeredDirectories || [],
    });

    this._emit("connected", `Connected as "${info.name}" (${info.storageLocationName || "unknown location"}).`, info);
    await this.client.heartbeat(registeredDirectories);
    this._tick();
    return info;
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this._emit("stopped", "Agent stopped.");
  }

  _scheduleNext(seconds) {
    if (!this.running) return;
    this.timer = setTimeout(() => this._tick(), seconds * 1000);
  }

  async _tick() {
    if (!this.running) return;

    try {
      const operations = await this.client.pollOperations();
      this.stats.lastPollAt = new Date().toISOString();
      this.consecutiveFailures = 0;
      this.stats.lastError = null;

      for (const operation of operations) {
        await this._handleOperation(operation);
      }

      // When work is arriving, poll again immediately -- a queued batch
      // shouldn't be drained one item per interval.
      this._scheduleNext(operations.length > 0 ? 0 : this.pollIntervalSeconds);
    } catch (err) {
      this.consecutiveFailures += 1;
      this.stats.lastError = err.message;
      this._emit("error", err.message);

      // A revoked agent is permanent -- stop rather than hammer the server.
      if (err.status === 401 && this.consecutiveFailures > 3) {
        this._emit("revoked", "This agent's credentials were rejected repeatedly. Stopping.");
        this.stop();
        return;
      }

      const backoff = Math.min(this.pollIntervalSeconds * 2 ** this.consecutiveFailures, MAX_BACKOFF_SECONDS);
      this._scheduleNext(backoff);
    }
  }

  async _handleOperation(operation) {
    try {
      const result = await this.executor.execute(operation.operationType, operation.payload);
      await this.client.reportResult(operation.id, { success: true, result });
      this.stats.operationsSucceeded += 1;
      this._emit("operation", `${operation.operationType} succeeded`, { id: operation.id });
    } catch (err) {
      this.stats.operationsFailed += 1;
      // Always report the failure. Staying silent would leave the backend
      // waiting until the operation expired, turning a clear "permission
      // denied" into an opaque timeout (docs/04 §4.5 principle 4).
      try {
        await this.client.reportResult(operation.id, { success: false, errorMessage: err.message });
      } catch (reportErr) {
        this._emit("error", `Could not report failure for ${operation.id}: ${reportErr.message}`);
      }
      this._emit("operation", `${operation.operationType} failed: ${err.message}`, { id: operation.id });
    }
  }
}

module.exports = { AgentRunner, DEFAULT_POLL_SECONDS, MAX_BACKOFF_SECONDS };
