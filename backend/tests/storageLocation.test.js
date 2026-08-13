// Root-path normalization is what stops a removed-then-re-added folder from
// being registered twice. If two spellings of the same directory don't
// compare equal, the duplicate-location check misses, the scan finds no
// existing files under the new location id, and every file is ingested a
// second time -- the "four files became eight" bug.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { normalizeRootPath } = require("../src/services/storageLocationService");

test("a trailing separator does not make a different folder", () => {
  const base = path.resolve("/data/docs");
  assert.strictEqual(normalizeRootPath("/data/docs"), base);
  assert.strictEqual(normalizeRootPath("/data/docs/"), base);
  assert.strictEqual(normalizeRootPath("/data/docs//"), base);
});

test("interior traversal is collapsed", () => {
  assert.strictEqual(normalizeRootPath("/data/docs/finance/.."), path.resolve("/data/docs"));
  assert.strictEqual(normalizeRootPath("/data/./docs"), path.resolve("/data/docs"));
});

test("surrounding whitespace is ignored", () => {
  assert.strictEqual(normalizeRootPath("  /data/docs  "), path.resolve("/data/docs"));
});

test("Windows Explorer's quoted 'Copy as path' is unwrapped", () => {
  // Explorer wraps the copied path in literal double quotes, and a quoted
  // string does not look absolute to Node's resolver -- it used to be
  // silently joined onto the backend's cwd, producing an ENOENT in the scan
  // worker rather than an obvious error.
  const expected = normalizeRootPath("C:\\Users\\me\\Docs");
  assert.strictEqual(normalizeRootPath('"C:\\Users\\me\\Docs"'), expected);
  assert.strictEqual(normalizeRootPath("'C:\\Users\\me\\Docs'"), expected);
  assert.strictEqual(normalizeRootPath('  "C:\\Users\\me\\Docs"  '), expected);
});

test("normalization is idempotent", () => {
  // create() normalizes on every call, so re-registering an already-stored
  // path must produce the identical string or the lookup misses.
  const once = normalizeRootPath("/data/docs/");
  assert.strictEqual(normalizeRootPath(once), once);
});

test("genuinely different folders stay different", () => {
  assert.notStrictEqual(normalizeRootPath("/data/docs"), normalizeRootPath("/data/docs-archive"));
  assert.notStrictEqual(normalizeRootPath("/data/docs"), normalizeRootPath("/data/docs/finance"));
});

test("the result is always absolute", () => {
  // A relative root would be resolved against the worker's cwd at scan
  // time, which is a different process than the API -- the classic way a
  // scan mysteriously finds nothing.
  assert.strictEqual(path.isAbsolute(normalizeRootPath("relative/docs")), true);
});
