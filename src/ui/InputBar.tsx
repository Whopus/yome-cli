import React, { useState, useMemo, useCallback, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { PermissionMode } from '../permissions/types.js';

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
  permissionMode?: PermissionMode;
  imageCount?: number;
}

const MAX_VISIBLE = 5;

function getPermissionLabel(mode: PermissionMode): { text: string; color: string } {
  switch (mode) {
    case 'bypassPermissions':
      // Red is preserved as a danger signal — overrides every prompt.
      return { text: 'Bypass - all commands allowed', color: '#FF6B6B' };
    case 'acceptEdits':
      // Mid-orange: somewhere between safe and danger.
      return { text: 'Auto - edit and read-only commands', color: '#E7BD1F' };
    case 'default':
    default:
      // Brand orange for the safe / default mode (was cyan).
      return { text: 'Default - ask before write operations', color: '#E87B35' };
  }
}

export function InputBar({ value, onChange, onSubmit, model, loopName, slashCommands = [], permissionMode = 'default', imageCount = 0 }: InputBarProps) {
  const [cursor, setCursor] = useState(0);
  const suppressNextChange = useRef(false);

  const filtered = useMemo(() => {
    if (!value.startsWith('/')) return [];
    const query = value.slice(1).toLowerCase();
    return slashCommands.filter((c) => c.name.toLowerCase().startsWith(query));
  }, [value, slashCommands]);

  const showSuggestions = filtered.length > 0 && value.startsWith('/') && !value.includes(' ');

  useMemo(() => {
    setCursor(0);
  }, [filtered.length]);

  const handleChange = useCallback((v: string) => {
    if (suppressNextChange.current) {
      suppressNextChange.current = false;
      return;
    }
    onChange(v);
  }, [onChange]);

  const handleSubmit = useCallback((v: string) => {
    if (showSuggestions && filtered[cursor]) {
      const selected = '/' + filtered[cursor]!.name;
      onChange(selected);
      onSubmit(selected);
    } else {
      onSubmit(v);
    }
  }, [showSuggestions, filtered, cursor, onChange, onSubmit]);

  useInput((input, key) => {
    // Suppress Ctrl+V so ink-text-input doesn't insert 'v'
    if (key.ctrl && input === 'v') {
      suppressNextChange.current = true;
      return;
    }
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

  // Compute visible window for scrollable slash menu
  const visibleStart = useMemo(() => {
    if (filtered.length <= MAX_VISIBLE) return 0;
    const half = Math.floor(MAX_VISIBLE / 2);
    let start = cursor - half;
    if (start < 0) start = 0;
    if (start + MAX_VISIBLE > filtered.length) start = filtered.length - MAX_VISIBLE;
    return start;
  }, [cursor, filtered.length]);

  const visibleItems = showSuggestions ? filtered.slice(visibleStart, visibleStart + MAX_VISIBLE) : [];
  const hasScrollUp = visibleStart > 0;
  const hasScrollDown = visibleStart + MAX_VISIBLE < filtered.length;

  const perm = getPermissionLabel(permissionMode);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box paddingX={1} justifyContent="space-between">
        <Text color={perm.color}>{perm.text}</Text>
        <Text dimColor>{model || 'qwen-plus'}</Text>
      </Box>
      {imageCount > 0 && (
        <Box paddingX={1}>
          <Text color="#E87B35" bold>{`\u{1F4CE} ${imageCount} image${imageCount > 1 ? 's' : ''} attached`}</Text>
          <Text dimColor> (press Enter to send)</Text>
        </Box>
      )}
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color="#E87B35">{`> `}</Text>
        <TextInput
          value={value}
          onChange={handleChange}
          onSubmit={handleSubmit}
          placeholder=""
        />
      </Box>
      {showSuggestions && (
        <Box flexDirection="column" paddingX={1} marginTop={0}>
          {hasScrollUp && (
            <Box>
              <Text dimColor>  {'↑'} more</Text>
            </Box>
          )}
          {visibleItems.map((item, vi) => {
            const realIdx = visibleStart + vi;
            const isFocused = realIdx === cursor;
            const padded = ('/' + item.name).padEnd(maxNameLen + 3);
            return (
              <Box key={item.name}>
                <Text color={isFocused ? '#E87B35' : undefined} dimColor={!isFocused} bold={isFocused}>{padded}</Text>
                <Text dimColor={!isFocused}>{item.description}</Text>
              </Box>
            );
          })}
          {hasScrollDown && (
            <Box>
              <Text dimColor>  {'↓'} more</Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
