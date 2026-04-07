import React, { useState, useMemo, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';

export interface SlashCommand {
  name: string;
  description: string;
}

interface InputBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  model?: string;
  loopName: string;
  slashCommands?: SlashCommand[];
}

export function InputBar({ value, onChange, onSubmit, model, loopName, slashCommands = [] }: InputBarProps) {
  const [cursor, setCursor] = useState(0);

  const filtered = useMemo(() => {
    if (!value.startsWith('/')) return [];
    const query = value.slice(1).toLowerCase();
    return slashCommands.filter((c) => c.name.toLowerCase().startsWith(query));
  }, [value, slashCommands]);

  const showSuggestions = filtered.length > 0 && value.startsWith('/') && !value.includes(' ');

  // Reset cursor when filtered list changes
  useMemo(() => {
    setCursor(0);
  }, [filtered.length]);

  const handleChange = useCallback((v: string) => {
    onChange(v);
  }, [onChange]);

  const handleSubmit = useCallback((v: string) => {
    if (showSuggestions && filtered[cursor]) {
      const selected = '/' + filtered[cursor]!.name;
      onChange(selected);
      // If it's a complete command (like /skills, /agents), submit directly
      onSubmit(selected);
    } else {
      onSubmit(v);
    }
  }, [showSuggestions, filtered, cursor, onChange, onSubmit]);

  useInput((_input, key) => {
    if (!showSuggestions) return;
    if (key.upArrow) {
      setCursor((prev) => (prev > 0 ? prev - 1 : filtered.length - 1));
    } else if (key.downArrow) {
      setCursor((prev) => (prev < filtered.length - 1 ? prev + 1 : 0));
    } else if (key.tab) {
      if (filtered[cursor]) {
        onChange('/' + filtered[cursor]!.name);
      }
    }
  });

  const maxNameLen = showSuggestions
    ? Math.max(...filtered.map((c) => c.name.length))
    : 0;

  return (
    <Box flexDirection="column" marginTop={1}>
      {showSuggestions && (
        <Box flexDirection="column" paddingX={1} marginBottom={0}>
          {filtered.map((item, i) => {
            const isFocused = i === cursor;
            const padded = ('/' + item.name).padEnd(maxNameLen + 3);
            return (
              <Box key={item.name}>
                <Text color={isFocused ? 'cyan' : 'yellow'} bold={isFocused}>{padded}</Text>
                <Text dimColor={!isFocused}>{item.description}</Text>
              </Box>
            );
          })}
        </Box>
      )}
      <Box paddingX={1} justifyContent="space-between">
        <Text color="#E7BD1F">Auto ({loopName}) - edit and read-only commands</Text>
        <Text dimColor>{model || 'qwen-plus'}</Text>
      </Box>
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color="yellow">{`> `}</Text>
        <TextInput
          value={value}
          onChange={handleChange}
          onSubmit={handleSubmit}
          placeholder=""
        />
      </Box>
    </Box>
  );
}
