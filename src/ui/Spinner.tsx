// Spinner — uses the shared frame driver in animation.ts.
//
// Single global setInterval ticks every animated component in lock step,
// so 100 spinners + 1 shimmer cost the same as 1 spinner.

import React from 'react';
import { Text } from 'ink';
import { useFrame } from './animation.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function Spinner({ color = 'cyan' }: { color?: string }) {
  const frame = useFrame();
  return <Text color={color}>{FRAMES[frame % FRAMES.length]}</Text>;
}
