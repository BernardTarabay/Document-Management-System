import { useEffect, useRef } from "react";

const ACTIVITY_EVENTS = ["mousedown", "mousemove", "keydown", "wheel", "touchstart", "scroll"];

/**
 * Real session timeout. Without this, a logged-in user stays logged in
 * forever: apiClient silently refreshes the 15-minute access token off the
 * back of a 7-day refresh token on every 401, and that refresh token lives
 * in localStorage across browser restarts -- so "close the tab, come back
 * tomorrow" still shows you as signed in. This adds an idle timer on top of
 * that server-side token lifecycle: no mouse/keyboard/scroll activity for
 * `timeoutMs` logs the user out client-side (and revokes the refresh token
 * via the normal logout() call), independent of whether the token itself
 * would still technically be valid.
 */
export function useIdleLogout(onTimeout, { timeoutMs, enabled = true } = {}) {
  const timeoutRef = useRef(null);
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  useEffect(() => {
    if (!enabled || !timeoutMs) return undefined;

    function reset() {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => onTimeoutRef.current(), timeoutMs);
    }

    ACTIVITY_EVENTS.forEach((evt) => window.addEventListener(evt, reset, { passive: true }));
    document.addEventListener("visibilitychange", reset);
    reset();

    return () => {
      ACTIVITY_EVENTS.forEach((evt) => window.removeEventListener(evt, reset));
      document.removeEventListener("visibilitychange", reset);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [enabled, timeoutMs]);
}
