// The backend half of the Filesystem Agent path guard
// (docs/04-storage-architecture.md §4.5 principle 3: "the backend validates
// every requested path ... path traversal is rejected server-side, never
// left to the agent to police").
//
// The agent enforces the same rules again locally (desktop-agent/tests/
// operations.test.js). That duplication is deliberate, not an oversight:
// neither side trusts the other, so both are tested independently.
process.env.AGENT_JWT_SECRET = "test-agent-secret";
process.env.JWT_ACCESS_SECRET = "test-access-secret";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { assertPathAllowed, parseDirectories, verifySessionToken } = require("../src/services/agentService");
const { PathTraversalError } = require("../src/utils/pathSafety");

const ROOT = path.resolve("/srv/agent-root");

test("paths inside the root and inside a registered directory are allowed", () => {
  assert.doesNotThrow(() => assertPathAllowed("Finance/budget.pdf", ROOT, ["Finance"]));
  assert.doesNotThrow(() => assertPathAllowed("Finance", ROOT, ["Finance"]));
  assert.doesNotThrow(() => assertPathAllowed("Finance/Reports/q1.pdf", ROOT, ["Finance"]));
});

test("an empty registered-directory list means the whole root", () => {
  assert.doesNotThrow(() => assertPathAllowed("anything/at/all.pdf", ROOT, []));
  assert.doesNotThrow(() => assertPathAllowed("anything.pdf", ROOT, null));
});

test("traversal above the root is rejected before any agent is involved", () => {
  for (const evil of ["../outside.pdf", "../../etc/passwd", "Finance/../../escape.pdf"]) {
    assert.throws(() => assertPathAllowed(evil, ROOT, []), PathTraversalError, `should reject ${evil}`);
  }
});

test("a path inside the root but outside the registered directories is rejected", () => {
  assert.throws(() => assertPathAllowed("Personal/notes.pdf", ROOT, ["Finance"]), /registered directories/);
});

test("registered directories match on segment boundaries, not string prefixes", () => {
  // "Finance" must not authorize "Finance-Private" -- the same off-by-one
  // that resolveWithinRoot guards against for the root itself.
  assert.throws(() => assertPathAllowed("Finance-Private/x.pdf", ROOT, ["Finance"]), /registered directories/);
});

test("backslash-separated paths are normalized before matching", () => {
  // A Windows agent reports its registered directories with backslashes;
  // without normalization the segment match would silently never fire and
  // every operation would be refused.
  assert.doesNotThrow(() => assertPathAllowed("Finance\\budget.pdf", ROOT, ["Finance"]));
  assert.doesNotThrow(() => assertPathAllowed("Finance/budget.pdf", ROOT, ["Finance\\"]));
});

test("parseDirectories tolerates the shapes jsonb round-trips as", () => {
  assert.deepStrictEqual(parseDirectories(["a", "b"]), ["a", "b"]);
  assert.deepStrictEqual(parseDirectories('["a","b"]'), ["a", "b"]);
  assert.deepStrictEqual(parseDirectories(null), []);
  assert.deepStrictEqual(parseDirectories(""), []);
  assert.deepStrictEqual(parseDirectories("not json"), []);
  assert.deepStrictEqual(parseDirectories('{"not":"an array"}'), []);
});

test("an agent session token is not interchangeable with a user token", () => {
  // Signed with AGENT_JWT_SECRET, verified only by the agent middleware.
  // A user access token presented to an agent route must fail outright.
  const { signAccessToken } = require("../src/utils/jwt");
  const userToken = signAccessToken({ id: "u1", email: "a@example.org" });
  assert.throws(() => verifySessionToken(userToken));
});

test("a token without kind:agent is rejected even when correctly signed", () => {
  const jwt = require("jsonwebtoken");
  const wrongKind = jwt.sign({ sub: "agent-1", kind: "user" }, process.env.AGENT_JWT_SECRET);
  assert.throws(() => verifySessionToken(wrongKind), /Not an agent token/);

  const right = jwt.sign({ sub: "agent-1", kind: "agent" }, process.env.AGENT_JWT_SECRET);
  assert.strictEqual(verifySessionToken(right).sub, "agent-1");
});
