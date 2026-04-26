import React from 'react';
import { Box, Text } from 'ink';
import { getVersion } from '../config.js';

const LOGO = `
\u2588\u2588    \u2588\u2588   \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588   \u2588\u2588\u2588    \u2588\u2588\u2588   \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588
 \u2588\u2588  \u2588\u2588    \u2588\u2588     \u2588\u2588   \u2588\u2588\u2588\u2588  \u2588\u2588\u2588\u2588   \u2588\u2588
  \u2588\u2588\u2588\u2588     \u2588\u2588     \u2588\u2588   \u2588\u2588 \u2588\u2588\u2588\u2588 \u2588\u2588   \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588
   \u2588\u2588      \u2588\u2588     \u2588\u2588   \u2588\u2588  \u2588\u2588  \u2588\u2588   \u2588\u2588
   \u2588\u2588      \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588   \u2588\u2588      \u2588\u2588   \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588
`.trim();

const LOGO_LINES = LOGO.split('\n');
// All logo lines are padded to the same visual width by the source
// glyph art; `█` (U+2588) is a single-cell character so .length is
// already the column width. We measure once at module load.
const LOGO_WIDTH = Math.max(...LOGO_LINES.map((l) => l.length));

// Snapshot the terminal width at module load. <Static> commits its
// content ONCE to scrollback, so even if the user later resizes the
// terminal the printed banner won't move — meaning we don't need a
// useStdoutDimensions / resize listener here. Falling back to 80
// matches the standard tty default.
const TERM_WIDTH = process.stdout.columns ?? 80;
const LEFT_PAD = Math.max(0, Math.floor((TERM_WIDTH - LOGO_WIDTH) / 2));
const PAD_STR = ' '.repeat(LEFT_PAD);

// Memoized — props are () so the banner only renders once per mount.
// We CAN'T rely on Box `alignItems="center"` here because Banner is
// rendered inside Ink's <Static>, which writes its children directly
// to the scrollback line-by-line and bypasses Yoga's flex layout.
// Centering is therefore done with manual leading whitespace.
export const Banner = React.memo(function Banner() {
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      {LOGO_LINES.map((line, i) => (
        <Text key={i} bold>{PAD_STR}{line}</Text>
      ))}
      <Text dimColor>{' '.repeat(Math.max(0, Math.floor((TERM_WIDTH - `v${getVersion()}`.length) / 2)))}v{getVersion()}</Text>
    </Box>
  );
});
