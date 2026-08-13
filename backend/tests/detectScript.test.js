// The chatbot kept answering in French to English questions. The prompt
// already told it not to; the documents around it are French and that won
// the argument. detectScript() is the hard per-turn signal that settles it,
// so its ranges need to be right -- they are written as literal Unicode
// ranges, which are easy to mangle in an editor and would then misdetect
// silently rather than fail.
const test = require("node:test");
const assert = require("node:assert");

const { detectScript } = require("../src/services/ai/geminiChatService");

test("English is Latin", () => {
  assert.equal(detectScript("can you move this file to Finance"), "Latin");
});

test("French is also Latin -- script detection deliberately does not guess the language", () => {
  assert.equal(detectScript("déplace ce fichier vers Finance"), "Latin");
});

test("Arabic is detected", () => {
  assert.equal(detectScript("انقل هذا الملف إلى المالية"), "Arabic");
});

test("Hebrew is detected", () => {
  assert.equal(detectScript("העבר את הקובץ הזה"), "Hebrew");
});

test("Cyrillic is detected", () => {
  assert.equal(detectScript("переместить файл"), "Cyrillic");
});

test("CJK is detected", () => {
  assert.equal(detectScript("移动这个文件"), "CJK");
});

test("a message with no letters yields no directive", () => {
  assert.equal(detectScript("12345 !!! ???"), null);
  assert.equal(detectScript(""), null);
  assert.equal(detectScript(null), null);
});

test("Arabic wins over incidental Latin, since a filename is not the message", () => {
  // The exact failure mode being guarded: the user's own words are Arabic,
  // but the sentence also names a Latin-script file.
  assert.equal(detectScript("انقل Rapport_2024.pdf إلى المالية"), "Arabic");
});
