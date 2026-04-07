import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

interface PermissionPromptProps {
  toolName: string;
  message: string;
  detail?: string;
  onAllow: () => void;
  onDeny: () => void;
  onAlwaysAllow: () => void;
}

const OPTIONS = [
  { id: 'allow', label: '是，允许' },
  { id: 'always', label: '是，并始终允许该命令（所有可逆命令）' },
  { id: 'deny', label: '不，取消' },
] as const;

export function PermissionPrompt({ toolName, message, detail, onAllow, onDeny, onAlwaysAllow }: PermissionPromptProps) {
  const [cursor, setCursor] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) {
      setCursor((prev) => (prev > 0 ? prev - 1 : OPTIONS.length - 1));
    } else if (key.downArrow) {
      setCursor((prev) => (prev < OPTIONS.length - 1 ? prev + 1 : 0));
    } else if (key.return) {
      const selected = OPTIONS[cursor]!.id;
      if (selected === 'allow') onAllow();
      else if (selected === 'always') onAlwaysAllow();
      else onDeny();
    } else if (key.escape) {
      onDeny();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      {OPTIONS.map((opt, i) => {
        const isFocused = i === cursor;
        const pointer = isFocused ? '> ' : '  ';
        return (
          <Box key={opt.id}>
            <Text color={isFocused ? 'yellow' : undefined} bold={isFocused}>{pointer}{opt.label}</Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>{'\u2191\u2193'} 导航  Enter 选择  Esc 取消</Text>
      </Box>
    </Box>
  );
}
