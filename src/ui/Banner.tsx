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

// Memoized — props are () so the banner only renders once per mount.
// Keeping it always-on-screen is intentional (per UX spec), and memo
// prevents it from re-diffing on every token in a streaming response.
export const Banner = React.memo(function Banner() {
  return (
    <Box flexDirection="column" alignItems="center" marginTop={1} marginBottom={1}>
      <Box flexDirection="column">
        {LOGO.split('\n').map((line, i) => (
          <Text key={i} bold>{line}</Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>v{getVersion()}</Text>
      </Box>
    </Box>
  );
});
