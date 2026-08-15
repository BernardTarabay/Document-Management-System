const subjectService = require("../services/subjectService");
const fileRepository = require("../repositories/fileRepository");
const triageRepository = require("../repositories/triageRepository");
const geminiChatService = require("../services/ai/geminiChatService");
const { ValidationError } = require("../validators/validationError");

/**
 * The subject tree is always fetched fresh from the DB here rather than
 * trusted from the request body -- the frontend already has it loaded
 * (SubjectsPage's useApiData), but re-fetching means a stale client can't
 * feed the model an out-of-date tree and get confidently wrong proposals
 * about ids that no longer exist.
 *
 * `context.files` USED to be passed straight through on the reasoning that it
 * is only read context and every proposed action is re-validated at Apply
 * time. That is still true of the ACTIONS, but it was wrong about the
 * CONVERSATION: a client could put any file ids it liked in the context, and
 * the model would then describe those documents -- filename, path, subject --
 * back in its reply. The reply is not validated by anything, so it became a
 * read oracle for another account's files, reachable without ever clicking
 * Apply.
 *
 * So the visible-file list is now filtered to files the caller actually owns
 * before it reaches the model. Anything else is dropped silently, which is
 * correct here: it is context, not a request, and a client sending ids it
 * does not own is either stale or probing.
 */
async function chat(req, res) {
  const { message, history, context } = req.body || {};
  if (!message || !String(message).trim()) {
    throw new ValidationError("message is required.");
  }

  const subjectTree = await subjectService.list({}, req.user.id);
  const selectedSubject = context?.selectedSubjectId
    ? subjectTree.find((s) => s.id === context.selectedSubjectId) || null
    : null;

  // Bounded before the database sees it -- an unbounded id list would be a
  // free full-table read dressed up as page context.
  const requestedIds = (Array.isArray(context?.files) ? context.files : [])
    .map((f) => f?.id)
    .filter((id) => typeof id === "string")
    .slice(0, 200);

  const ownedFiles = requestedIds.length
    ? await fileRepository.listByIdsForOwner(requestedIds, req.user.id)
    : [];

  const describe = (f) => ({
    id: f.id,
    filename: f.canonical_filename || f.filename_current,
    path: f.current_path,
    subjectName: f.subject_name || null,
  });

  const visibleFiles = ownedFiles.map(describe);

  /**
   * THE UNFILED BACKLOG, ALWAYS IN SCOPE.
   *
   * Whatever page you are on, "put the passport scan in Personal" has to
   * work. Before this, the assistant only saw `context.files` -- whatever the
   * current page happened to have rendered -- so on the Dashboard it could see
   * nothing, and on Triage or Photos it saw whatever those pages sent, which
   * was nothing at all. It could not act on the two piles that most need
   * acting on.
   *
   * So the files actually waiting for a decision are always included: the
   * triage queue and the unreviewed photos. These are precisely the documents
   * the user is likely to be talking about, and they are the ones the
   * assistant is useless without.
   *
   * Bounded, and owner-scoped by the repository queries themselves. Deduped
   * against the page context so a file visible on screen is not listed twice
   * under two different descriptions -- the model treats a repeated id as two
   * documents and proposes two moves for it.
   */
  const [triageRows, photoRows] = await Promise.all([
    triageRepository.list(req.user.id, { limit: 60, offset: 0 }).catch(() => []),
    fileRepository.listPhotos(req.user.id, { limit: 60, offset: 0 }).catch(() => []),
  ]);

  const seen = new Set(visibleFiles.map((f) => f.id));
  const backlog = [];
  for (const row of [...triageRows, ...photoRows]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    backlog.push({
      ...describe(row),
      // Says WHY it is waiting, so the model can explain its choice rather
      // than filing blind -- "this one is a photo with no readable text" is a
      // better basis for a suggestion than a bare filename.
      waitingBecause: row.reason || (row.is_image ? "a photo awaiting review" : "unfiled"),
    });
  }

  const selectableFiles = [...visibleFiles, ...backlog];

  const result = await geminiChatService.chat({
    message,
    history: Array.isArray(history) ? history : [],
    subjectTree,
    visibleFiles: selectableFiles,
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
