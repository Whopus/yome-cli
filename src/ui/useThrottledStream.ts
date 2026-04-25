// useThrottledStream — coalesce high-frequency text deltas into ~30fps UI updates.
//
// LLM streams emit dozens of token deltas per second. Calling React setState
// on every delta forces Ink to reconcile + paint the entire tree per token —
// which on long sessions snowballs into terminal IO storms (the root cause of
// the "long session crashes my terminal" bug). Claude Code / Gemini CLI both
// solve this by debouncing the live region: tokens are appended to a ref, and
// React state is updated on a timer.
//
// This hook returns:
//   - displayText: the throttled state suitable for rendering
//   - append:      O(1) ref-mutation, safe to call from inside an LLM stream
//   - reset:       clear buffer + state (call on /new, on done, before next run)
//   - flush:       force-publish ref buffer to state immediately
//
// Frame rate is capped at ~30 fps (33ms) by default — Ink's own renderer caps
// at 30 fps anyway, so anything faster is wasted work.

import { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_INTERVAL_MS = 33;

export interface ThrottledStream {
  displayText: string;
  append: (delta: string) => void;
  reset: () => void;
  flush: () => void;
}

export function useThrottledStream(intervalMs: number = DEFAULT_INTERVAL_MS): ThrottledStream {
  const [displayText, setDisplayText] = useState('');
  const bufferRef = useRef('');
  const lastPublishedRef = useRef('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const ensureTimer = useCallback(() => {
    if (timerRef.current) return;
    timerRef.current = setInterval(() => {
      if (bufferRef.current !== lastPublishedRef.current) {
        lastPublishedRef.current = bufferRef.current;
        setDisplayText(bufferRef.current);
      }
    }, intervalMs);
  }, [intervalMs]);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const append = useCallback((delta: string) => {
    bufferRef.current += delta;
    ensureTimer();
  }, [ensureTimer]);

  const flush = useCallback(() => {
    if (bufferRef.current !== lastPublishedRef.current) {
      lastPublishedRef.current = bufferRef.current;
      setDisplayText(bufferRef.current);
    }
  }, []);

  const reset = useCallback(() => {
    stopTimer();
    bufferRef.current = '';
    lastPublishedRef.current = '';
    setDisplayText('');
  }, [stopTimer]);

  // Cleanup on unmount — critical for long sessions to avoid orphaned timers.
  useEffect(() => {
    return () => stopTimer();
  }, [stopTimer]);

  return { displayText, append, reset, flush };
}
