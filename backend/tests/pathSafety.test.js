// Path traversal is the one bug class here that turns "rename a file" into
// "write anywhere on the host", so these cases are deliberately adversarial
// rather than happy-path.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { resolveWithinRoot, PathTraversalError } = require("../src/utils/pathSafety");

const ROOT = path.resolve("/srv/repo");

test("resolveWithinRoot allows paths inside the root", () => {
  assert.strictEqual(resolveWithinRoot(ROOT, "a.pdf"), path.join(ROOT, "a.pdf"));
  assert.strictEqual(resolveWithinRoot(ROOT, "sub/dir/a.pdf"), path.join(ROOT, "sub", "dir", "a.pdf"));
  // Traversal that stays inside the root is legitimate.
  assert.strictEqual(resolveWithinRoot(ROOT, "sub/../a.pdf"), path.join(ROOT, "a.pdf"));
});

test("resolveWithinRoot allows the root itself", () => {
  assert.strictEqual(resolveWithinRoot(ROOT, "."), ROOT);
});

test("resolveWithinRoot rejects traversal above the root", () => {
  for (const evil of [
    "../outside.txt",
    "../../etc/passwd",
    "sub/../../outside.txt",
    "./../../outside.txt",
  ]) {
    assert.throws(
      () => resolveWithinRoot(ROOT, evil),
      PathTraversalError,
      `expected "${evil}" to be rejected`
    );
  }
});

test("resolveWithinRoot rejects an absolute path pointing elsewhere", () => {
  const elsewhere = path.resolve("/etc/passwd");
  assert.throws(() => resolveWithinRoot(ROOT, elsewhere), PathTraversalError);
});

test("resolveWithinRoot rejects a sibling dir sharing the root's name prefix", () => {
  // The classic off-by-one in a startsWith() check: "/srv/repo-evil" starts
  // with "/srv/repo" as a string but is NOT inside it. Guarded by comparing
  // against root + path.sep.
  assert.throws(() => resolveWithinRoot(ROOT, "../repo-evil/x.txt"), PathTraversalError);
});

test("PathTraversalError does not leak the resolved path to the client", () => {
  try {
    resolveWithinRoot(ROOT, "../../etc/passwd");
    assert.fail("should have thrown");
  } catch (err) {
    assert.strictEqual(err.statusCode, 400);
    assert.strictEqual(err.publicMessage, "Invalid path");
    // The detailed message stays internal (server logs), not in publicMessage.
    assert.match(err.message, /escapes storage root/);
  }
});





