// Electron main process for the Filesystem Agent.
//
// All privileged work (filesystem, network, credentials) happens here. The
// renderer is a plain status/settings window with no Node access at all --
// see preload.js for the narrow, explicitly-listed bridge between them.
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require("electron");
const path = require("path");

const { AgentConfig } = require("./config");
const { BackendClient } = require("./backendClient");
const { AgentRunner } = require("./agentRunner");

let mainWindow = null;
let tray = null;
let config = null;
let runner = null;
const recentEvents = [];
const MAX_EVENTS = 200;

function recordEvent(event) {
  const entry = { ...event, at: new Date().toISOString() };
  recentEvents.unshift(entry);
  if (recentEvents.length > MAX_EVENTS) recentEvents.length = MAX_EVENTS;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("agent:event", entry);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 680,
    title: "Document Management - Filesystem Agent",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // The renderer displays status and collects settings; it has no
      // business touching Node APIs, and an agent that brokers filesystem
      // access is exactly the wrong place to relax this.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("close", (event) => {
    // Closing the window leaves the agent running in the tray -- an agent
    // that stopped brokering because someone clicked X would make scans
    // fail for reasons the user never connected to that click.
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  // A 1x1 transparent image keeps this dependency-free; a real icon file
  // would be a packaging concern, not a functional one.
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip("Document Management Filesystem Agent");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show status", click: () => (mainWindow ? mainWindow.show() : createWindow()) },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on("click", () => (mainWindow ? mainWindow.show() : createWindow()));
}

async function startAgent() {
  if (!config.isConfigured()) {
    throw new Error("Set the server URL, agent ID and API key before connecting.");
  }
  if (runner) runner.stop();

  const client = new BackendClient({
    serverUrl: config.values.serverUrl,
    agentId: config.values.agentId,
    apiKey: config.values.apiKey,
  });

  runner = new AgentRunner({
    client,
    pollIntervalSeconds: config.values.pollIntervalSeconds,
    onEvent: recordEvent,
  });

  return runner.start(config.values.registeredDirectories);
}

function status() {
  return {
    config: config.redacted(),
    running: Boolean(runner && runner.running),
    stats: runner ? runner.stats : null,
    agent: runner && runner.client ? runner.client.agentInfo || null : null,
    events: recentEvents.slice(0, 50),
  };
}

app.whenReady().then(async () => {
  config = new AgentConfig(app.getPath("userData"));
  await config.load();

  createWindow();
  createTray();

  // Auto-connect on launch when already configured, so a machine that
  // reboots overnight comes back online without anyone opening the window.
  if (config.isConfigured()) {
    startAgent().catch((err) => recordEvent({ type: "error", message: err.message }));
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // Intentionally does NOT quit: the agent lives in the tray.
});

app.on("before-quit", () => {
  app.isQuitting = true;
  if (runner) runner.stop();
});

// --- IPC ----------------------------------------------------------------

ipcMain.handle("agent:getStatus", () => status());

ipcMain.handle("agent:saveConfig", async (_event, patch) => {
  // Only these keys are writable from the renderer.
  const allowed = ["serverUrl", "agentId", "apiKey", "registeredDirectories", "pollIntervalSeconds"];
  const clean = {};
  for (const key of allowed) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) clean[key] = patch[key];
  }
  await config.save(clean);
  recordEvent({ type: "config", message: "Configuration saved." });
  return config.redacted();
});

ipcMain.handle("agent:connect", async () => {
  try {
    const info = await startAgent();
    return { ok: true, agent: info };
  } catch (err) {
    recordEvent({ type: "error", message: err.message });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("agent:disconnect", () => {
  if (runner) runner.stop();
  return { ok: true };
});

ipcMain.handle("agent:chooseDirectory", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a directory this agent may operate on",
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});
