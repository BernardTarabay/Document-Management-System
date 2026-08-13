const subjectService = require("../services/subjectService");
const geminiChatService = require("../services/ai/geminiChatService");
const { ValidationError } = require("../validators/validationError");

/**
 * The subject tree is always fetched fresh from the DB here rather than
 * trusted from the request body -- the frontend already has it loaded
 * (SubjectsPage's useApiData), but re-fetching means a stale client can't
 * feed the model an out-of-date tree and get confidently wrong proposals
 * about ids that no longer exist. `context.files` (whatever's currently
 * visible in the UI) is passed through as-is since it's just read context
 * for the model, not something that gets written anywhere -- every
 * proposed action still has to pass through the normal, independently
 * validated REST endpoints when a human clicks Apply.
 */
async function chat(req, res) {
  const { message, history, context } = req.body || {};
  if (!message || !String(message).trim()) {
    throw new ValidationError("message is required.");
  }

  const subjectTree = await subjectService.list();
  const selectedSubject = context?.selectedSubjectId
    ? subjectTree.find((s) => s.id === context.selectedSubjectId) || null
    : null;

  const result = await geminiChatService.chat({
    message,
    history: Array.isArray(history) ? history : [],
    subjectTree,
    visibleFiles: Array.isArray(context?.files) ? context.files : [],
    selectedSubject,
    // Which page the user is on and what is on it. Read-only hint for the
    // model so "rename this" can resolve against what they are looking at;
    // bounded so a client cannot stuff the prompt.
    pageContext: context?.page
      ? {
          page: String(context.page).slice(0, 60),
          description: String(context.description || "").slice(0, 400),
        }
      : null,
  });

  res.json(result);
}

module.exports = { chat };
