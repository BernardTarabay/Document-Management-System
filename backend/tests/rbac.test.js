// requirePermission is the actual enforcement point for RBAC -- the
// frontend hiding a button is cosmetic, this is what stops the request
// (see the comment at the top of the middleware). Pure unit test: the
// middleware only reads req.user, so no DB or HTTP server is needed.
const test = require("node:test");
const assert = require("node:assert");

const { requirePermission } = require("../src/middleware/requirePermission");

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function run(middleware, req) {
  const res = fakeRes();
  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

test("401 when no authenticated user is attached", () => {
  const { res, nextCalled } = run(requirePermission("email.manage"), {});
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(nextCalled, false, "must not fall through to the handler");
});

test("403 when the user lacks the permission", () => {
  const { res, nextCalled } = run(requirePermission("email.manage"), {
    user: { id: "u1", permissions: ["document.view"] },
  });
  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.error, /email\.manage/);
  assert.strictEqual(nextCalled, false);
});

test("calls next() when the user holds the permission", () => {
  const { res, nextCalled } = run(requirePermission("email.manage"), {
    user: { id: "u1", permissions: ["document.view", "email.manage"] },
  });
  assert.strictEqual(res.statusCode, null, "no response written");
  assert.strictEqual(nextCalled, true);
});

test("403 on an empty permission list", () => {
  const { res, nextCalled } = run(requirePermission("email.manage"), {
    user: { id: "u1", permissions: [] },
  });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(nextCalled, false);
});

test("permission matching is exact, not a prefix or substring", () => {
  // "email.manage.readonly" must not satisfy "email.manage", and holding
  // "email.manage" must not satisfy a narrower key.
  const held = { user: { id: "u1", permissions: ["email.manage.readonly"] } };
  assert.strictEqual(run(requirePermission("email.manage"), held).nextCalled, false);

  const broad = { user: { id: "u1", permissions: ["email.manage"] } };
  assert.strictEqual(run(requirePermission("email.manage.readonly"), broad).nextCalled, false);
});

test("permission matching is case-sensitive", () => {
  const { nextCalled } = run(requirePermission("email.manage"), {
    user: { id: "u1", permissions: ["EMAIL.MANAGE"] },
  });
  assert.strictEqual(nextCalled, false);
});

test("each returned middleware is bound to its own permission key", () => {
  const a = requirePermission("document.view");
  const b = requirePermission("user.manage");
  const req = { user: { id: "u1", permissions: ["document.view"] } };
  assert.strictEqual(run(a, req).nextCalled, true);
  assert.strictEqual(run(b, req).nextCalled, false);
});
