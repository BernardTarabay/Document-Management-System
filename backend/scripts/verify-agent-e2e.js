// End-to-end Phase 12 verification against the RUNNING API and a REAL
// agent runner (the Electron shell is not involved -- agentRunner.js and
// operations.js have no Electron dependency, which is why they live outside
// main.js).
//
// Proves the full loop: backend enqueues a typed operation -> agent polls,
// claims, executes it on a real temp filesystem -> reports back ->
// AgentStorageService resolves. Cleans up everything it creates.
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");

const env = require("../src/config/env");
const { Pool } = require("pg");
const agentService = require("../src/services/agentService");
const storageLocationRepository = require("../src/repositories/storageLocationRepository");
const filesystemAgentRepository = require("../src/repositories/filesystemAgentRepository");
const { getStorageServiceFor } = require("../src/services/storage/storageService");

const AGENT_SRC = path.join(__dirname, "..", "..", "desktop-agent", "src");
const { BackendClient } = require(path.join(AGENT_SRC, "backendClient"));
const { AgentRunner } = require(path.join(AGENT_SRC, "agentRunner"));

const pool = new Pool({ connectionString: env.databaseUrl });
const log = (...a) => console.log(...a);

let root;
let locationId;
let agentId;
let runner;

async function setup() {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "dms-agent-e2e-"));
  await fsp.mkdir(path.join(root, "Finance", "Reports"), { recursive: true });
  await fsp.writeFile(path.join(root, "Finance", "budget.txt"), "the budget for 2026");
  await fsp.writeFile(path.join(root, "Finance", "Reports", "q1.txt"), "first quarter report");
  await fsp.writeFile(path.join(root, "readme.txt"), "top level file");
  log("temp root:", root);

  const { rows } = await pool.query(
    // owner_user_id became NOT NULL in migration 028. This raw INSERT predates
    // that and had been failing on the not-null violation ever since -- which
    // nobody saw, because this script exited 0 either way.
    `INSERT INTO storage_locations (name, type, root_path, access_mode, is_active, owner_user_id)
     VALUES ($1,'local',$2,'agent',true,
             (SELECT id FROM users ORDER BY created_at LIMIT 1)) RETURNING *`,
    ["E2E Agent Location", root]
  );
  locationId = rows[0].id;
  log("storage location:", locationId, "(access_mode=agent)");

  const admin = await pool.query("SELECT id FROM users ORDER BY created_at LIMIT 1");
  const registered = await agentService.register(
    { storageLocationId: locationId, name: "E2E Test Agent", registeredDirectories: [] },
    admin.rows[0].id
  );
  agentId = registered.agent.id;
  log("agent registered:", agentId, " apiKey length:", registered.apiKey.length);

  const client = new BackendClient({
    serverUrl: `http://localhost:${env.port}`,
    agentId,
    apiKey: registered.apiKey,
  });
  runner = new AgentRunner({ client, pollIntervalSeconds: 1, onEvent: (e) => log("   [agent]", e.type, e.message || "") });
  const info = await runner.start([]);
  log("agent session open. rootPath from server:", info.rootPath);
}

async function cleanup() {
  if (runner) runner.stop();
  try {
    if (agentId) await pool.query("DELETE FROM filesystem_agents WHERE id = $1", [agentId]);
    if (locationId) await pool.query("DELETE FROM storage_locations WHERE id = $1", [locationId]);
    if (root) await fsp.rm(root, { recursive: true, force: true });
    log("\ncleaned up temp dir, agent and storage location.");
  } catch (e) {
    log("cleanup warning:", e.message);
  }
  await pool.end();
}

async function run() {
  await setup();

  const location = await storageLocationRepository.findById(locationId);
  const storage = getStorageServiceFor(location);
  log("\nStorageService selected:", storage.constructor.name);

  log("\n--- listDirectory through the agent ---");
  const entries = [];
  for await (const entry of storage.listDirectory()) entries.push(entry);
  entries.forEach((e) => log(`   ${path.relative(root, e.path).replace(/\\/g, "/")}  (${e.size} bytes)`));
  const listOk = entries.length === 3;
  log("   listDirectory:", listOk ? "OK (3 files)" : `FAIL (${entries.length} files)`);

  log("\n--- stat through the agent ---");
  const stat = await storage.stat("Finance/budget.txt");
  log("   exists:", stat.exists, " size:", stat.size, " mtime:", stat.mtime instanceof Date);
  const statOk = stat.exists && stat.size === "the budget for 2026".length;
  log("   stat:", statOk ? "OK" : "FAIL");

  log("\n--- readStream through the agent ---");
  const chunks = [];
  await new Promise((resolve, reject) => {
    const s = storage.readStream("Finance/budget.txt");
    s.on("data", (c) => chunks.push(c));
    s.on("end", resolve);
    s.on("error", reject);
  });
  const content = Buffer.concat(chunks).toString("utf8");
  log("   content:", JSON.stringify(content));
  const readOk = content === "the budget for 2026";
  log("   readStream:", readOk ? "OK" : "FAIL");

  log("\n--- rename (+ move into a new folder) through the agent ---");
  const newPath = await storage.rename("Finance/budget.txt", "Budget_2026.txt", "Finance/Archive");
  const renamedOnDisk = fs.existsSync(path.join(root, "Finance", "Archive", "Budget_2026.txt"));
  log("   reported newPath:", newPath, " exists on disk:", renamedOnDisk);
  const renameOk = renamedOnDisk && !fs.existsSync(path.join(root, "Finance", "budget.txt"));
  log("   rename:", renameOk ? "OK" : "FAIL");

  log("\n--- path traversal is refused (backend-side, before dispatch) ---");
  let traversalBlocked = false;
  let traversalMsg = "";
  try {
    await storage.stat("../../../etc/passwd");
  } catch (err) {
    traversalBlocked = true;
    traversalMsg = err.message;
  }
  log("   blocked:", traversalBlocked, "-", traversalMsg.slice(0, 90));

  log("\n--- registered-directory scoping ---");
  await filesystemAgentRepository.updateEnrollment(agentId, { registeredDirectories: ["Finance"] });
  let scopeBlocked = false;
  let scopeMsg = "";
  try {
    await storage.stat("readme.txt"); // inside root, outside "Finance"
  } catch (err) {
    scopeBlocked = true;
    scopeMsg = err.message;
  }
  log("   readme.txt (outside Finance) blocked:", scopeBlocked, "-", scopeMsg.slice(0, 90));

  log("\n--- operation audit trail ---");
  const ops = await pool.query(
    `SELECT operation_type, status FROM agent_operations WHERE agent_id = $1 ORDER BY created_at`,
    [agentId]
  );
  ops.rows.forEach((r) => log(`   ${r.operation_type.padEnd(16)} ${r.status}`));

  const allOk = listOk && statOk && readOk && renameOk && traversalBlocked && scopeBlocked;
  log("\n================ RESULT:", allOk ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED", "================");
  // `allOk` was computed, printed, and then thrown away. This is the script
  // `npm run verify:agent` runs -- the only one wired into package.json -- so
  // for as long as it exited 0 regardless, that command could not fail.
  if (!allOk) failed = true;
}

// Set by run() when a check fails, and by the catch below when it throws.
// Module scope so the finally can read it after either path.
let failed = false;

run()
  .catch((e) => { console.error("\nFAILED:", e); failed = true; })
  .finally(async () => {
    await cleanup();
    process.exitCode = failed ? 1 : 0;
  });

