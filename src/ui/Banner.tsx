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

export function Banner() {
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
}
