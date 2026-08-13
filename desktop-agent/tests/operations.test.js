// The agent's own path guard. docs/04-storage-architecture.md §4.5 says a
// compromised agent must not become arbitrary filesystem access; the
// symmetric claim -- which these tests cover -- is that a compromised or
// buggy BACKEND must not either. The agent re-validates every path locally
// rather than trusting the server that sent it.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");

const {
  createExecutor,
  resolveWithinRoot,
  assertWithinRegistered,
  PathEscapeError,
} = require("../src/operations");

async function makeRoot() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dms-agent-test-"));
  await fsp.mkdir(path.join(root, "Finance", "Reports"), { recursive: true });
  await fsp.mkdir(path.join(root, "Personal"), { recursive: true });
  await fsp.writeFile(path.join(root, "Finance", "budget.txt"), "budget contents");
  await fsp.writeFile(path.join(root, "Finance", "Reports", "q1.txt"), "q1 report");
  await fsp.writeFile(path.join(root, "Personal", "notes.txt"), "personal notes");
  return root;
}

// --- path guards --------------------------------------------------------

test("resolveWithinRoot accepts paths inside the root", () => {
  const root = path.resolve("/srv/repo");
  assert.strictEqual(resolveWithinRoot(root, "a.txt"), path.join(root, "a.txt"));
  assert.strictEqual(resolveWithinRoot(root, "sub/../a.txt"), path.join(root, "a.txt"));
  assert.strictEqual(resolveWithinRoot(root, "."), root);
});

test("resolveWithinRoot rejects traversal, absolute escapes and prefix siblings", () => {
  const root = path.resolve("/srv/repo");
  for (const evil of ["../outside.txt", "../../etc/passwd", "sub/../../out.txt", "../repo-evil/x.txt"]) {
    assert.throws(() => resolveWithinRoot(root, evil), PathEscapeError, `should reject ${evil}`);
  }
  assert.throws(() => resolveWithinRoot(root, path.resolve("/etc/passwd")), PathEscapeError);
});

test("an empty registered-directory list means the whole root", () => {
  assert.doesNotThrow(() => assertWithinRegistered("/srv/repo", "anything/at/all.txt", []));
});

test("registered directories are matched on segment boundaries", () => {
  const dirs = ["Finance"];
  assert.doesNotThrow(() => assertWithinRegistered("/srv/repo", "Finance/budget.txt", dirs));
  assert.doesNotThrow(() => assertWithinRegistered("/srv/repo", "Finance", dirs));
  // "Finance" must not authorize "Finance-Private" -- the same off-by-one
  // a naive startsWith() check would allow.
  assert.throws(() => assertWithinRegistered("/srv/repo", "Finance-Private/x.txt", dirs), PathEscapeError);
  assert.throws(() => assertWithinRegistered("/srv/repo", "Personal/notes.txt", dirs), PathEscapeError);
});

// --- executor -----------------------------------------------------------

test("list_directory walks the tree and returns root-relative paths", async () => {
  const root = await makeRoot();
  const executor = createExecutor({ rootPath: root, registeredDirectories: [] });

  const { entries, nextCursor } = await executor.execute("list_directory", { path: "." });
  const paths = entries.map((e) => e.path).sort();

  assert.deepStrictEqual(paths, ["Finance/Reports/q1.txt", "Finance/budget.txt", "Personal/notes.txt"]);
  assert.strictEqual(nextCursor, null, "a complete listing has no next page");
  assert.ok(entries.every((e) => !path.isAbsolute(e.path)), "paths must be root-relative");
  assert.ok(entries.every((e) => typeof e.size === "number" && e.mtime));
});

test("list_directory paginates", async () => {
  const root = await makeRoot();
  const executor = createExecutor({ rootPath: root, registeredDirectories: [] });

  const first = await executor.execute("list_directory", { path: ".", pageSize: 2 });
  assert.strictEqual(first.entries.length, 2);
  assert.strictEqual(first.nextCursor, "2");

  const second = await executor.execute("list_directory", { path: ".", pageSize: 2, cursor: first.nextCursor });
  assert.strictEqual(second.entries.length, 1);

  const all = [...first.entries, ...second.entries].map((e) => e.path);
  assert.strictEqual(new Set(all).size, 3, "pages must not overlap or drop entries");
});

test("stat reports existence without throwing on a missing file", async () => {
  const root = await makeRoot();
  const executor = createExecutor({ rootPath: root, registeredDirectories: [] });

  const found = await executor.execute("stat", { path: "Finance/budget.txt" });
  assert.strictEqual(found.exists, true);
  assert.strictEqual(found.size, "budget contents".length);

  const missing = await executor.execute("stat", { path: "Finance/nope.txt" });
  assert.strictEqual(missing.exists, false);
  assert.strictEqual(missing.size, 0);
});

test("read_file round-trips bytes through base64", async () => {
  const root = await makeRoot();
  const executor = createExecutor({ rootPath: root, registeredDirectories: [] });

  const result = await executor.execute("read_file", { path: "Finance/budget.txt" });
  assert.strictEqual(Buffer.from(result.contentBase64, "base64").toString("utf8"), "budget contents");
});

test("rename moves a file and reports its new root-relative path", async () => {
  const root = await makeRoot();
  const executor = createExecutor({ rootPath: root, registeredDirectories: [] });

  const result = await executor.execute("rename", {
    path: "Finance/budget.txt",
    newFileName: "Budget_2026.txt",
  });

  assert.strictEqual(result.newPath, "Finance/Budget_2026.txt");
  assert.strictEqual(fs.existsSync(path.join(root, "Finance", "Budget_2026.txt")), true);
  assert.strictEqual(fs.existsSync(path.join(root, "Finance", "budget.txt")), false);
});

test("rename can also move into a new folder, creating it", async () => {
  const root = await makeRoot();
  const executor = createExecutor({ rootPath: root, registeredDirectories: [] });

  const result = await executor.execute("rename", {
    path: "Finance/budget.txt",
    newFileName: "Budget.txt",
    targetRelativeDir: "Finance/Archive/2026",
  });

  assert.strictEqual(result.newPath, "Finance/Archive/2026/Budget.txt");
  assert.strictEqual(fs.existsSync(path.join(root, "Finance", "Archive", "2026", "Budget.txt")), true);
});

test("rename refuses a filename containing a path separator", async () => {
  const root = await makeRoot();
  const executor = createExecutor({ rootPath: root, registeredDirectories: [] });

  // A separator here would redirect the write out of the checked directory.
  for (const evil of ["../escaped.txt", "sub/nested.txt", "..\\escaped.txt"]) {
    await assert.rejects(
      () => executor.execute("rename", { path: "Finance/budget.txt", newFileName: evil }),
      PathEscapeError,
      `should reject newFileName "${evil}"`
    );
  }
  assert.strictEqual(fs.existsSync(path.join(root, "Finance", "budget.txt")), true, "original must be untouched");
});

test("the executor rejects a backend-supplied path outside the root", async () => {
  const root = await makeRoot();
  const executor = createExecutor({ rootPath: root, registeredDirectories: [] });

  // Simulates a compromised or buggy backend issuing a traversal path.
  for (const op of [
    ["stat", { path: "../../etc/passwd" }],
    ["read_file", { path: "../../etc/passwd" }],
    ["remove", { path: "../../etc/passwd" }],
    ["move", { fromPath: "Finance/budget.txt", toPath: "../../tmp/stolen.txt" }],
  ]) {
    await assert.rejects(() => executor.execute(op[0], op[1]), PathEscapeError, `should reject ${op[0]}`);
  }
});

test("the executor enforces registered directories independently of the server", async () => {
  const root = await makeRoot();
  const executor = createExecutor({ rootPath: root, registeredDirectories: ["Finance"] });

  await assert.doesNotReject(() => executor.execute("stat", { path: "Finance/budget.txt" }));
  // Inside the root, but outside what this agent agreed to broker.
  await assert.rejects(() => executor.execute("stat", { path: "Personal/notes.txt" }), PathEscapeError);
});

test("remove deletes only the targeted file", async () => {
  const root = await makeRoot();
  const executor = createExecutor({ rootPath: root, registeredDirectories: [] });

  await executor.execute("remove", { path: "Personal/notes.txt" });
  assert.strictEqual(fs.existsSync(path.join(root, "Personal", "notes.txt")), false);
  assert.strictEqual(fs.existsSync(path.join(root, "Finance", "budget.txt")), true);
});

test("an unknown operation type is refused, not guessed at", async () => {
  const executor = createExecutor({ rootPath: os.tmpdir(), registeredDirectories: [] });
  await assert.rejects(() => executor.execute("exec_shell", { cmd: "rm -rf /" }), /Unsupported operation type/);
});

test("the supported operation set is exactly the documented one", () => {
  const executor = createExecutor({ rootPath: os.tmpdir(), registeredDirectories: [] });
  assert.deepStrictEqual(executor.supportedOperations.sort(), [
    "list_directory",
    "move",
    "read_file",
    "remove",
    "rename",
    "stat",
  ]);
});
