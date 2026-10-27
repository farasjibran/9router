"use client";

/**
 * useVisibilityInterval — setInterval that pauses while the tab is hidden.
 *
 * Background dashboard tabs used to keep polling the API forever. On a busy
 * machine that stacks up: every poll triggers a React re-render, and the user
 * feels it as lag on the tab they *are* looking at.
 *
 * This hook only runs `callback` on an interval while `document.hidden` is
 * false. When the tab becomes visible again it fires once immediately so the
 * UI is not stale, then resumes the normal cadence.
 *
 * @param {Function} callback - called on each tick (and on re-focus)
 * @param {number|null} delay - interval in ms; pass null/0 to disable
 * @param {boolean} [runOnMount=true] - fire once on mount
 */

import { useEffect, useRef } from "react";

export function useVisibilityInterval(callback, delay, runOnMount = true) {
  const savedCallback = useRef(callback);

  // Keep the latest callback without restarting the interval.
  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!delay) return;
    if (typeof document === "undefined") return;

    const tick = () => {
      if (document.hidden) return;
      savedCallback.current?.();
    };

    if (runOnMount) tick();

    const timer = setInterval(tick, delay);

    // Resume with an immediate refresh so the visible UI is never stale.
    const onVisibilityChange = () => {
      if (!document.hidden) savedCallback.current?.();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [delay, runOnMount]);
}

export default useVisibilityInterval;
