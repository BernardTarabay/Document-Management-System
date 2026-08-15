import { useEffect, useState } from "react";
import { api } from "../services/apiClient";

/**
 * An authenticated image URL for use in `<img src>`.
 *
 * WHY THIS IS NECESSARY
 *
 * The obvious thing -- `<img src="/api/files/123/preview">` -- does not work
 * here and fails in the most confusing way possible. The access token lives
 * in localStorage, not a cookie, so a browser-initiated image request carries
 * no Authorization header, the endpoint answers 401, and the browser renders
 * a broken-image icon. To the user that reads as "this file is corrupt", when
 * in fact the bytes are fine and the request was simply unauthenticated.
 *
 * So the image is fetched like every other request, through the API client
 * that attaches the token and handles a silent refresh-and-retry, and the
 * response becomes an object URL.
 *
 * WHY THE REVOKE MATTERS
 *
 * Every object URL pins its blob in memory until revoked. The Photos grid
 * creates one per tile and replaces the whole set on every page change; at 96
 * images a page, forgetting this leaks the decoded bytes of every photo the
 * user has scrolled past for the life of the tab. The cleanup below runs on
 * unmount AND on every path change, which is what makes paging safe.
 *
 * @param {string|null} path - API path, e.g. "/files/<id>/preview"
 * @returns {{url: string|null, loading: boolean, error: Error|null}}
 */
export function useAuthedImage(path) {
  const [state, setState] = useState({ url: null, loading: Boolean(path), error: null });

  useEffect(() => {
    if (!path) {
      setState({ url: null, loading: false, error: null });
      return undefined;
    }

    // Guards against a slow response for a previous path arriving after the
    // component has moved on -- without it, flipping quickly through the
    // viewer can leave you looking at the photo before last.
    let cancelled = false;
    let objectUrl = null;

    setState({ url: null, loading: true, error: null });

    api.previewBlobUrl(path)
      .then(({ url }) => {
        if (cancelled) { URL.revokeObjectURL(url); return; }
        objectUrl = url;
        setState({ url, loading: false, error: null });
      })
      .catch((error) => {
        if (cancelled) return;
        setState({ url: null, loading: false, error });
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  return state;
}
