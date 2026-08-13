// Renderer: status display and settings. No Node access -- everything goes
// through the narrow `agentApi` bridge defined in preload.js.
const els = {
  statusPill: document.getElementById("status-pill"),
  serverUrl: document.getElementById("serverUrl"),
  agentId: document.getElementById("agentId"),
  apiKey: document.getElementById("apiKey"),
  pollInterval: document.getElementById("pollInterval"),
  save: document.getElementById("save"),
  connect: document.getElementById("connect"),
  disconnect: document.getElementById("disconnect"),
  directories: document.getElementById("directories"),
  addDir: document.getElementById("addDir"),
  events: document.getElementById("events"),
  statLocation: document.getElementById("stat-location"),
  statRoot: document.getElementById("stat-root"),
  statPoll: document.getElementById("stat-poll"),
  statOk: document.getElementById("stat-ok"),
  statFail: document.getElementById("stat-fail"),
};

let directories = [];

function setPill(state, label) {
  els.statusPill.className = `pill pill-${state}`;
  els.statusPill.textContent = label;
}

function renderDirectories() {
  // Built with DOM APIs rather than innerHTML: these strings are real
  // filesystem paths chosen by the user, and a path can contain anything.
  els.directories.replaceChildren();

  if (directories.length === 0) {
    const li = document.createElement("li");
    li.textContent = "(entire storage location root)";
    els.directories.append(li);
    return;
  }

  directories.forEach((dir, index) => {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = dir;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      directories.splice(index, 1);
      renderDirectories();
    });

    li.append(span, remove);
    els.directories.append(li);
  });
}

function addEvent(event) {
  const li = document.createElement("li");

  const time = document.createElement("time");
  time.textContent = new Date(event.at || Date.now()).toLocaleTimeString();

  const message = document.createElement("span");
  message.className = `type-${event.type}`;
  message.textContent = event.message || event.type;

  li.append(time, message);
  els.events.prepend(li);

  while (els.events.children.length > 100) {
    els.events.lastElementChild.remove();
  }

  if (event.type === "connected") setPill("online", "Connected");
  if (event.type === "stopped" || event.type === "revoked") setPill("offline", "Disconnected");
  if (event.type === "error") setPill("error", "Error");
}

function applyStatus(status) {
  const cfg = status.config || {};
  els.serverUrl.value = cfg.serverUrl || "";
  els.agentId.value = cfg.agentId || "";
  els.pollInterval.value = cfg.pollIntervalSeconds || 5;
  // The stored key is never sent to the renderer; the placeholder tells the
  // user that leaving the field blank keeps it.
  els.apiKey.placeholder = cfg.hasApiKey ? "•••••••• (stored)" : "required";

  directories = Array.isArray(cfg.registeredDirectories) ? [...cfg.registeredDirectories] : [];
  renderDirectories();

  setPill(status.running ? "online" : "offline", status.running ? "Connected" : "Disconnected");

  if (status.agent) {
    els.statLocation.textContent = status.agent.storageLocationName || "—";
    els.statRoot.textContent = status.agent.rootPath || "—";
  }
  if (status.stats) {
    els.statPoll.textContent = status.stats.lastPollAt
      ? new Date(status.stats.lastPollAt).toLocaleTimeString()
      : "—";
    els.statOk.textContent = status.stats.operationsSucceeded ?? 0;
    els.statFail.textContent = status.stats.operationsFailed ?? 0;
  }

  els.events.replaceChildren();
  (status.events || []).slice().reverse().forEach(addEvent);
}

async function collectConfig() {
  const patch = {
    serverUrl: els.serverUrl.value.trim(),
    agentId: els.agentId.value.trim(),
    registeredDirectories: directories,
    pollIntervalSeconds: Math.max(1, parseInt(els.pollInterval.value, 10) || 5),
  };
  // Only overwrite the stored key when the user actually typed a new one.
  const key = els.apiKey.value.trim();
  if (key) patch.apiKey = key;

  await window.agentApi.saveConfig(patch);
  els.apiKey.value = "";
}

els.save.addEventListener("click", async () => {
  await collectConfig();
  addEvent({ type: "config", message: "Configuration saved." });
});

els.connect.addEventListener("click", async () => {
  await collectConfig();
  const result = await window.agentApi.connect();
  if (!result.ok) addEvent({ type: "error", message: result.error });
  applyStatus(await window.agentApi.getStatus());
});

els.disconnect.addEventListener("click", async () => {
  await window.agentApi.disconnect();
  applyStatus(await window.agentApi.getStatus());
});

els.addDir.addEventListener("click", async () => {
  const chosen = await window.agentApi.chooseDirectory();
  if (chosen && !directories.includes(chosen)) {
    directories.push(chosen);
    renderDirectories();
  }
});

window.agentApi.onEvent(addEvent);

// Refresh the counters periodically; events arrive by push, but poll
// timestamps and totals only change in the main process.
setInterval(async () => {
  const status = await window.agentApi.getStatus();
  if (status.stats) {
    els.statPoll.textContent = status.stats.lastPollAt
      ? new Date(status.stats.lastPollAt).toLocaleTimeString()
      : "—";
    els.statOk.textContent = status.stats.operationsSucceeded ?? 0;
    els.statFail.textContent = status.stats.operationsFailed ?? 0;
  }
}, 3000);

window.agentApi.getStatus().then(applyStatus);
