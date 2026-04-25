// animation.ts — single shared frame driver for every animated component.
//
// Previously each <Spinner> / animated text mounted its own setInterval.
// With many concurrent indicators that meant N timers all firing every
// frame, each independently re-rendering. This module exposes ONE timer
// that ticks at FRAME_INTERVAL_MS, and a tiny pub/sub so any component
// can subscribe to the global frame counter. The interval auto-stops
// when the last subscriber leaves and is .unref()'d so it never blocks
// process exit.

import { useEffect, useState } from 'react';

export const FRAME_INTERVAL_MS = 80;

let currentFrame = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const subscribers = new Set<(frame: number) => void>();

function ensureTimer(): void {
  if (timer || subscribers.size === 0) return;
  timer = setInterval(() => {
    // Use a large modulus so consumers can take whatever sub-period
    // they want (Spinner: %10, Shimmer: %width, etc.) without a wrap
    // boundary every few hundred ms.
    currentFrame = (currentFrame + 1) % 1_000_000;
    for (const cb of subscribers) cb(currentFrame);
  }, FRAME_INTERVAL_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

function maybeStopTimer(): void {
  if (subscribers.size === 0 && timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Subscribe a React component to the global frame ticker. */
export function useFrame(): number {
  const [frame, setFrame] = useState(currentFrame);
  useEffect(() => {
    subscribers.add(setFrame);
    ensureTimer();
    return () => {
      subscribers.delete(setFrame);
      maybeStopTimer();
    };
  }, []);
  return frame;
}
