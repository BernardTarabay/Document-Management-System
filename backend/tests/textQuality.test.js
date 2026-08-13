// The two ways this can be wrong are not symmetric.
//
// A false GIBBERISH verdict costs a real document its automatic name -- it
// keeps the name it already had, and a human can still rename it. A false OK
// is the bug being fixed: noise reaches the AI tier, which invents a
// confident title from it, which becomes a rename proposal against a real
// document. So the false-positive tests below (especially the Arabic and
// French ones) matter more than the detection tests.
const test = require("node:test");
const assert = require("node:assert");

const { assessText, wouldBenefitFromOcr, VERDICTS } = require("../src/services/extraction/textQuality");

// --- real text must survive ------------------------------------------------

test("ordinary English prose is usable", () => {
  const r = assessText(
    "This agreement is made between the parties on the fifteenth of March, and sets out the terms " +
    "under which the supplier will deliver the goods described in schedule one."
  );
  assert.equal(r.usable, true, r.reason || "");
});

test("French prose with accents is usable", () => {
  const r = assessText(
    "Conférences des Carmélites déchaussées au Liban. Le présent rapport décrit les activités du " +
    "couvent pendant l'année écoulée, ainsi que les dépenses engagées par la province."
  );
  assert.equal(r.usable, true, r.reason || "");
});

test("Arabic is usable and is NOT judged by vowel ratio", () => {
  const r = assessText(
    "هذا التقرير السنوي يوضح أنشطة الدير خلال العام الماضي والنفقات التي تم صرفها من قبل الإدارة المحلية"
  );
  assert.equal(r.usable, true, r.reason || "");
  assert.equal(r.stats.script, "arabic");
  assert.equal(r.stats.vowelRatio, null, "the Latin vowel rule must not run on Arabic");
});

test("Hebrew is usable", () => {
  const r = assessText("הדוח השנתי הזה מתאר את הפעילות של המנזר בשנה שעברה ואת ההוצאות שהוצאו");
  assert.equal(r.usable, true, r.reason || "");
});

test("a spreadsheet's terse header row is still usable", () => {
  const r = assessText("Sheet1 Title Reference Amount Department Invoice Supplier Date Total Paid");
  assert.equal(r.usable, true, r.reason || "");
});

// --- noise must be caught --------------------------------------------------

test("empty text is not usable", () => {
  assert.equal(assessText("").verdict, VERDICTS.EMPTY);
  assert.equal(assessText("   \n\t ").verdict, VERDICTS.EMPTY);
});

test("a couple of stray words is too short to name anything from", () => {
  assert.equal(assessText("Scan 001").verdict, VERDICTS.TOO_SHORT);
});

test("a big file yielding almost nothing is flagged as having no text layer", () => {
  const r = assessText("Scanned image page 1 of 4 document", { sizeBytes: 4 * 1024 * 1024 });
  assert.equal(r.verdict, VERDICTS.NO_TEXT_LAYER);
  assert.equal(r.usable, false);
});

test("character-per-token spray from a broken font encoding is gibberish", () => {
  const r = assessText("T h i s i s n o t r e a l t e x t a t a l l i t i s a b r o k e n f o n t");
  assert.equal(r.verdict, VERDICTS.GIBBERISH);
});

test("mostly punctuation and symbols is gibberish", () => {
  const r = assessText("§§ ¶¶ •••• ~~~~ ||||| ==== ++++ ---- **** #### @@@@ %%%% &&&& ^^^^ <<<>>>");
  assert.equal(r.verdict, VERDICTS.GIBBERISH);
});

test("undecodable characters are gibberish", () => {
  const r = assessText("���� ���� ���� ���� ���� ���� document ���� ���� ����");
  assert.equal(r.verdict, VERDICTS.GIBBERISH);
});

test("consonant soup from a failed encoding is gibberish", () => {
  const r = assessText("Zdrmn qxstz phhtl wknmr grtpz dksnb vgcmn rtplk mnbvc xzqwr tgbhn");
  assert.equal(r.verdict, VERDICTS.GIBBERISH);
});

// --- the OCR hint ----------------------------------------------------------

test("an unreadable PDF is worth OCR", () => {
  const a = assessText("", { sizeBytes: 2 * 1024 * 1024 });
  assert.equal(wouldBenefitFromOcr(a, "pdf"), true);
});

test("an unreadable database file is NOT worth OCR", () => {
  const a = assessText("");
  assert.equal(wouldBenefitFromOcr(a, "accdb"), false);
});

test("readable text is never sent to OCR", () => {
  const a = assessText("This is a perfectly readable paragraph of real text about invoices and suppliers.");
  assert.equal(wouldBenefitFromOcr(a, "pdf"), false);
});
