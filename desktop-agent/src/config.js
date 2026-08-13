// Agent configuration persistence.
//
// The API key is a long-lived credential granting brokered filesystem
// access, so it is stored in Electron's per-user application data
// directory (not next to the source, not in the repo) with owner-only
// permissions where the platform supports them.
//
// Being honest about the limit: this is plaintext on disk, protected by
// file permissions and the OS user account, exactly like an SSH private key
// without a passphrase. The OS keychain would be better and is the obvious
// upgrade, but it needs a native module -- deliberately avoided here for
// the same reason the backend has no vendor SDKs. Anyone who can read this
// file is already running as the user whose files the agent brokers.
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const FILE_NAME = "agent-config.json";

const DEFAULTS = {
  serverUrl: "",
  agentId: "",
  apiKey: "",
  registeredDirectories: [],
  pollIntervalSeconds: 5,
};

class AgentConfig {
  constructor(directory) {
    this.directory = directory;
    this.filePath = path.join(directory, FILE_NAME);
    this.values = { ...DEFAULTS };
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.filePath, "utf8");
      this.values = { ...DEFAULTS, ...JSON.parse(raw) };
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      // No config yet -- first run. Defaults stand.
    }
    return this.values;
  }

  async save(patch = {}) {
    this.values = { ...this.values, ...patch };
    await fsp.mkdir(this.directory, { recursive: true });
    // mode 0o600: owner read/write only. A no-op on Windows, which uses
    // ACLs inherited from the user's AppData directory instead.
    await fsp.writeFile(this.filePath, JSON.stringify(this.values, null, 2), { mode: 0o600 });
    return this.values;
  }

  /** Safe to hand to the renderer / log: never includes the API key. */
  redacted() {
    const { apiKey, ...rest } = this.values;
    return { ...rest, hasApiKey: Boolean(apiKey) };
  }

  isConfigured() {
    return Boolean(this.values.serverUrl && this.values.agentId && this.values.apiKey);
  }
}

module.exports = { AgentConfig, DEFAULTS };
