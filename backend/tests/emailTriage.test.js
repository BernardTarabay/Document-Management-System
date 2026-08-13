// The triage rule tier decides whether a message is auto-trashed with NO
// human review (docs/10-email-inbox.md), so the tests that matter most are
// the ones asserting it does NOT reach "junk" on weak evidence. ruleClassify
// is pure and makes no network calls; the AI escalation tier is not
// exercised here (it needs a live Gemini key).
const test = require("node:test");
const assert = require("node:assert");

const { ruleClassify } = require("../src/services/ai/emailTriageClassifier");

function msg(overrides = {}) {
  return {
    subject: "Quarterly report attached",
    fromAddress: "colleague@example.org",
    fromName: "A Colleague",
    snippet: "Please review.",
    providerHints: {},
    ...overrides,
  };
}

test("provider-flagged SPAM is junk", () => {
  const r = ruleClassify(msg({ providerHints: { gmailLabels: ["SPAM"] } }));
  assert.strictEqual(r.classification, "junk");
  assert.strictEqual(r.method, "rule");
  assert.strictEqual(r.confidenceLevel, "high");
});

test("promotions and social categories are junk", () => {
  for (const label of ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL"]) {
    const r = ruleClassify(msg({ providerHints: { gmailLabels: [label] } }));
    assert.strictEqual(r?.classification, "junk", `${label} should be junk`);
  }
});

test("IMPORTANT and PERSONAL labels are important", () => {
  for (const label of ["IMPORTANT", "CATEGORY_PERSONAL"]) {
    const r = ruleClassify(msg({ providerHints: { gmailLabels: [label] } }));
    assert.strictEqual(r?.classification, "important", `${label} should be important`);
  }
});

test("junk labels win over important labels when both are present", () => {
  // Gmail routinely applies IMPORTANT alongside CATEGORY_PROMOTIONS. The
  // ordering in ruleClassify decides this; pin it so a reordering is caught.
  const r = ruleClassify(msg({ providerHints: { gmailLabels: ["IMPORTANT", "CATEGORY_PROMOTIONS"] } }));
  assert.strictEqual(r.classification, "junk");
});

test("bulk sender + List-Unsubscribe is junk", () => {
  for (const from of [
    "no-reply@shop.example",
    "noreply@shop.example",
    "newsletter@news.example",
    "marketing@brand.example",
    "notifications@app.example",
    "do-not-reply@bank.example",
  ]) {
    const r = ruleClassify(msg({ fromAddress: from, providerHints: { hasListUnsubscribe: true } }));
    assert.strictEqual(r?.classification, "junk", `${from} + List-Unsubscribe should be junk`);
  }
});

test("a bulk sender WITHOUT List-Unsubscribe is not auto-junked", () => {
  // Transactional mail (receipts, password resets, 2FA) very often comes
  // from no-reply@ with no List-Unsubscribe. Auto-trashing those would be
  // the worst possible false positive, so this must fall through to the AI
  // tier rather than resolve to junk on the sender pattern alone.
  const r = ruleClassify(msg({ fromAddress: "no-reply@bank.example", subject: "Your receipt" }));
  assert.strictEqual(r, null, "should defer to the AI tier, not guess junk");
});

test("List-Unsubscribe alone is not enough to junk a message", () => {
  // Plenty of legitimate mailing lists a person actually reads carry this
  // header while coming from a human-looking address.
  const r = ruleClassify(msg({ fromAddress: "editor@journal.example", providerHints: { hasListUnsubscribe: true } }));
  assert.strictEqual(r, null);
});

test("promotional subject needs a corroborating bulk signal", () => {
  const promo = "Flash sale — 50% off, limited time offer";

  // Subject alone from a normal human sender: must NOT be junked.
  assert.strictEqual(ruleClassify(msg({ subject: promo })), null);

  // Subject + a bulk signal: junk.
  const withUnsub = ruleClassify(msg({ subject: promo, providerHints: { hasListUnsubscribe: true } }));
  assert.strictEqual(withUnsub?.classification, "junk");

  const withBulkSender = ruleClassify(msg({ subject: promo, fromAddress: "marketing@brand.example" }));
  assert.strictEqual(withBulkSender?.classification, "junk");
});

test("ordinary correspondence falls through to the AI tier", () => {
  assert.strictEqual(ruleClassify(msg()), null);
  assert.strictEqual(ruleClassify(msg({ subject: "Re: contract review", fromAddress: "lawyer@firm.example" })), null);
});

test("a business word that merely contains a promo term is not junked", () => {
  // "sale" appears inside "wholesale"; the patterns are \b-anchored phrases,
  // so a real invoice about a sale of goods must not trip the promo rule.
  const r = ruleClassify(msg({
    subject: "Wholesale invoice for the sale of equipment",
    providerHints: { hasListUnsubscribe: true },
  }));
  assert.strictEqual(r, null);
});

test("handles missing/empty fields without throwing", () => {
  assert.doesNotThrow(() => ruleClassify({}));
  assert.strictEqual(ruleClassify({}), null);
  assert.strictEqual(ruleClassify({ subject: null, fromAddress: null, providerHints: null }), null);
});

test("matching is case-insensitive on sender and subject", () => {
  const r = ruleClassify(msg({ fromAddress: "NO-REPLY@SHOP.EXAMPLE", providerHints: { hasListUnsubscribe: true } }));
  assert.strictEqual(r?.classification, "junk");

  const s = ruleClassify(msg({ subject: "FLASH SALE ends today", fromAddress: "MARKETING@brand.example" }));
  assert.strictEqual(s?.classification, "junk");
});

test("every rule result carries the fields the processor persists", () => {
  const r = ruleClassify(msg({ providerHints: { gmailLabels: ["SPAM"] } }));
  for (const key of ["classification", "confidenceLevel", "method", "reason"]) {
    assert.ok(r[key], `missing ${key}`);
  }
  assert.strictEqual(r.method, "rule");
  assert.ok(["important", "junk"].includes(r.classification));
  assert.ok(["low", "medium", "high"].includes(r.confidenceLevel));
});
