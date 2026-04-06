import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

interface InputBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  model?: string;
  loopName: string;
}

export function InputBar({ value, onChange, onSubmit, model, loopName }: InputBarProps) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box paddingX={1} justifyContent="space-between">
        <Text color="#E7BD1F">Auto ({loopName}) - edit and read-only commands</Text>
        <Text dimColor>{model || 'qwen-plus'}</Text>
      </Box>
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color="yellow">{`> `}</Text>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder=""
        />
      </Box>
    </Box>
  );
}
