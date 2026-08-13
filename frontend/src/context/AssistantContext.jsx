import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/**
 * Lets the assistant know what the user is currently looking at.
 *
 * The assistant lives in the app shell so it is available everywhere, but
 * "rename this file" only means something if it can see what "this" refers
 * to. Rather than the panel reaching into every page, each page PUBLISHES
 * its own context here and the panel reads whatever the current page put in.
 *
 * A page that publishes nothing simply gives the assistant no file context,
 * which is correct -- it will ask instead of guessing.
 */

const AssistantContext = createContext(null);

export function AssistantProvider({ children }) {
  const [context, setContext] = useState({ page: null, description: "", files: [], selectedSubjectId: null });
  // Bumped whenever a page asks the assistant to refresh its data after an
  // action was applied, so pages can react without the assistant needing a
  // direct reference to their reload functions.
  const [changeToken, setChangeToken] = useState(0);
  const notifyChanged = useCallback(() => setChangeToken((t) => t + 1), []);

  // "Show me where this lives." The assistant can find a file anywhere in the
  // corpus, but an answer in the chat panel is only half of it -- the useful
  // part is the map opening the branches above that file and lighting the
  // route to it. This is the channel for that request; a page that does not
  // implement it simply ignores it.
  //
  // Carries a counter alongside the id so asking for the SAME subject twice
  // still registers. Without it, a second request for a subject already
  // selected would be a no-op state write and nothing would move.
  const [reveal, setReveal] = useState({ subjectId: null, fileId: null, n: 0 });
  const revealSubject = useCallback(
    (subjectId, fileId = null) => setReveal((r) => ({ subjectId, fileId, n: r.n + 1 })),
    []
  );

  const value = useMemo(
    () => ({ context, setContext, changeToken, notifyChanged, reveal, revealSubject }),
    [context, changeToken, notifyChanged, reveal, revealSubject]
  );

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

export function useAssistant() {
  const ctx = useContext(AssistantContext);
  if (!ctx) throw new Error("useAssistant must be used within AssistantProvider");
  return ctx;
}

/**
 * Publish the current page's context to the assistant.
 *
 * @param {object} value
 * @param {string} value.page            - human-readable page name, e.g. "Files"
 * @param {string} [value.description]   - one line on what is on screen
 * @param {Array}  [value.files]         - [{ id, filename, currentPath }]
 * @param {string} [value.selectedSubjectId]
 */
export function usePublishAssistantContext({ page, description = "", files = [], selectedSubjectId = null }) {
  const { setContext } = useAssistant();

  // Serialised so a page re-rendering with an equal-but-new array does not
  // loop: setContext -> provider re-render -> page re-render -> new array.
  const key = JSON.stringify({
    page,
    description,
    selectedSubjectId,
    files: files.map((f) => f.id),
  });
  const latest = useRef({ page, description, files, selectedSubjectId });
  latest.current = { page, description, files, selectedSubjectId };

  useEffect(() => {
    setContext(latest.current);
    // Clear on unmount so a stale page's files never leak into the next one.
    return () => setContext({ page: null, description: "", files: [], selectedSubjectId: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, setContext]);
}

/**
 * Subscribe to "reveal this subject" requests from the assistant.
 * @param {(subjectId: string, fileId: string|null) => void} onReveal
 */
export function useAssistantReveal(onReveal) {
  const { reveal } = useAssistant();
  const seen = useRef(0);
  useEffect(() => {
    if (reveal.n === seen.current || !reveal.subjectId) return;
    seen.current = reveal.n;
    onReveal?.(reveal.subjectId, reveal.fileId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);
}

/** Re-run something whenever the assistant applied an action. */
export function useAssistantChanges(onChanged) {
  const { changeToken } = useAssistant();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    onChanged?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changeToken]);
}
