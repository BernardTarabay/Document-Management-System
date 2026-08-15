// Pull the model's text out of an Interactions API response envelope.
//
// The API answers with a `steps` array -- thoughts, tool calls, and the
// model's own output are all steps -- and the useful text is inside the output
// step's content blocks. Three modules had grown their own copy of this walk,
// with slightly different tolerances, which is exactly the shape of thing that
// works everywhere until one endpoint returns a variant and only one caller
// copes.
//
// This is the lenient version: it accepts the `steps`/`output` envelope, a
// string content block, an array of typed blocks, and the older
// candidates[].content.parts[] shape, because those are the shapes that have
// actually been observed from this endpoint.
function extractOutputText(payload) {
  const steps = payload?.steps || payload?.output || [];
  // Prefer the explicit model_output step when the envelope labels its steps;
  // a `thought` step also carries content, and reading that instead of the
  // answer is a silent wrong-answer bug rather than a parse failure.
  const ordered = Array.isArray(steps)
    ? [...steps.filter((s) => s?.type === "model_output"), ...steps.filter((s) => s?.type !== "model_output")]
    : [];

  for (const step of ordered) {
    const content = step?.content;
    if (typeof content === "string" && content.trim()) return content;
    if (Array.isArray(content)) {
      const text = content.filter((c) => typeof c?.text === "string").map((c) => c.text).join("");
      if (text.trim()) return text;
    }
  }

  const direct = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof direct === "string" && direct.trim()) return direct;
  return null;
}

module.exports = { extractOutputText };
