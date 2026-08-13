import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Small data-fetching hook shared by every list/detail page. Not a caching
 * library -- just removes the loading/error/refetch boilerplate that would
 * otherwise be copy-pasted into a dozen pages.
 *
 * REFETCHING WHEN THE TAB COMES BACK
 *
 * A page fetches once on mount and then shows those numbers forever. That is
 * wrong here, because plenty changes outside the browser: the worker keeps
 * processing, a scan finishes, the database gets reset from a script. The
 * symptom that prompted this was subject file counts still showing their old
 * values long after the database had been emptied -- the API was correctly
 * returning zero, the tab was just showing what it fetched an hour earlier,
 * with nothing on screen to suggest it was stale.
 *
 * SILENT vs VISIBLE RELOADS
 *
 * Background refetches (tab focus, polling) deliberately do NOT flip
 * `loading`. Doing so would tear the page down to a spinner every time you
 * alt-tabbed back to it, which is worse than the stale data it fixes. Only
 * an explicit reload() -- a user pressing something -- shows the spinner.
 *
 * @param {() => Promise<any>} fetcher
 * @param {any[]} deps - re-fetches whenever these change
 * @param {{refetchOnFocus?: boolean}} [options]
 */
export function useApiData(fetcher, deps = [], { refetchOnFocus = true } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [reloadTick, setReloadTick] = useState(0);
  const silent = useRef(false);

  const reload = useCallback(() => {
    silent.current = false;
    setReloadTick((t) => t + 1);
  }, []);

  const reloadSilently = useCallback(() => {
    silent.current = true;
    setReloadTick((t) => t + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!silent.current) setLoading(true);
    silent.current = false;
    setError(null);
    fetcher()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, reloadTick]);

  useEffect(() => {
    if (!refetchOnFocus) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") reloadSilently();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [refetchOnFocus, reloadSilently]);

  return { data, loading, error, reload, reloadSilently, setData };
}

/**
 * Polls a fetcher every `intervalMs` while `active` is true AND the tab is
 * visible.
 *
 * The visibility half matters more than it sounds. Three things poll on every
 * page -- the jobs dock at 2.5s, the sidebar badges at 30s, the Processing
 * Jobs page at 4s -- and none of them stopped when the tab was in the
 * background. A window left open overnight on a laptop kept a request every
 * couple of seconds going to an API whose answer nobody could see, which is
 * pure battery and log noise. useApiData's own focus handler already refetches
 * the moment the tab comes back, so nothing is stale on return.
 */
export function usePolling(fetcher, intervalMs, active = true, deps = []) {
  const { data, loading, error, reload, reloadSilently, setData } = useApiData(fetcher, deps);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");

  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  useEffect(() => {
    if (!active || !visible) return undefined;
    // Silent: a poll that blanks the panel to a spinner every few seconds
    // makes the thing it is polling unreadable.
    const id = setInterval(reloadSilently, intervalMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, visible, intervalMs, reloadSilently]);

  return { data, loading, error, reload, setData };
}
