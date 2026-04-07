import React from 'react';
import { Box, Text, useInput } from 'ink';

interface PermissionPromptProps {
  toolName: string;
  message: string;
  detail?: string;
  onAllow: () => void;
  onDeny: () => void;
  onAlwaysAllow: () => void;
}

export function PermissionPrompt({ toolName, message, detail, onAllow, onDeny, onAlwaysAllow }: PermissionPromptProps) {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') {
      onAllow();
    } else if (input === 'n' || input === 'N' || key.escape) {
      onDeny();
    } else if (input === 'a' || input === 'A') {
      onAlwaysAllow();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Box marginBottom={1}>
        <Text bold color="yellow">{'\u26A0'} Permission Required</Text>
      </Box>
      <Box>
        <Text bold>{toolName}</Text>
        <Text> — {message}</Text>
      </Box>
      {detail && (
        <Box marginTop={0}>
          <Text dimColor>{detail}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color="green" bold>y</Text><Text> allow  </Text>
        <Text color="red" bold>n</Text><Text> deny  </Text>
        <Text color="cyan" bold>a</Text><Text> always allow</Text>
      </Box>
    </Box>
  );
}
