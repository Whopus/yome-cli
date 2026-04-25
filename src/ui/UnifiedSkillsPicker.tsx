// UnifiedSkillsPicker — TUI for `/skills` slash command.
//
// Lists every skill the agent knows about, regardless of system:
//   - prompt skills: SKILL.md files under .yome/skills or .claude/skills
//   - hub skills:    yome-skill.json packages installed via `yome skill install`
//
// The kind column lets the user immediately see what they're toggling.
// Common actions (enable/disable) work uniformly; uninstall is hub-only
// because removing a SKILL.md should be left to the user's editor.

import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { UnifiedSkill } from '../yomeSkills/unified.js';
import { originLabel } from '../yomeSkills/unified.js';

interface UnifiedSkillsPickerProps {
  skills: UnifiedSkill[];
  onToggle: (skill: UnifiedSkill) => void;
  onUninstall: (skill: UnifiedSkill) => void;
  onAdd: () => void;
  onClose: () => void;
}

export function UnifiedSkillsPicker({
  skills,
  onToggle,
  onUninstall,
  onAdd,
  onClose,
}: UnifiedSkillsPickerProps) {
  const [cursor, setCursor] = useState(0);
  const focused = skills[cursor];

  const maxNameLen = useMemo(
    () => (skills.length > 0 ? Math.max(...skills.map((s) => s.name.length)) : 8),
    [skills],
  );
  const maxKindLen = useMemo(
    () => (skills.length > 0 ? Math.max(...skills.map((s) => originLabel(s).length)) : 4),
    [skills],
  );

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onClose();
      return;
    }
    if (input === 'a') {
      onAdd();
      return;
    }
    if (input === 'u' && focused && focused.kind === 'hub') {
      onUninstall(focused);
      return;
    }
    if (skills.length === 0) return;
    if (key.upArrow) setCursor((c) => (c > 0 ? c - 1 : skills.length - 1));
    else if (key.downArrow) setCursor((c) => (c < skills.length - 1 ? c + 1 : 0));
    else if (key.return || input === ' ') {
      if (focused) onToggle(focused);
    }
  });

  const promptCount = skills.filter((s) => s.kind === 'prompt').length;
  const hubCount = skills.filter((s) => s.kind === 'hub').length;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} width="100%">
      <Box marginBottom={1}>
        <Text bold color="#E87B35">Skills </Text>
        <Text dimColor>
          {'\u2014'} {hubCount} hub · {promptCount} prompt
        </Text>
      </Box>

      {skills.length === 0 && (
        <>
          <Text dimColor>No skills installed yet.</Text>
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>Try one of:</Text>
            <Text dimColor>  · /plugins             open the hub marketplace</Text>
            <Text dimColor>  · ~/.yome/skills/foo/SKILL.md      add a prompt skill</Text>
            <Text dimColor>  · ~/.claude/skills/foo/SKILL.md    Claude Code-format skill</Text>
          </Box>
        </>
      )}

      {skills.map((s, i) => {
        const isFocused = i === cursor;
        const pointer = isFocused ? '\u276F' : ' ';
        const toggle = s.enabled ? '\u25C9' : '\u25CB';
        const toggleColor = s.enabled ? '#E87B35' : 'gray';

        // Use ink's flex layout (fixed-width columns + wrap=truncate-end on
        // the description) instead of string .padEnd. padEnd uses JS char
        // count, which double-counts CJK glyphs (terminal renders them at
        // 2 columns) and lets long descriptions wrap mid-row, breaking the
        // grid alignment for hub skills (which often have CJK descriptions).
        const nameColWidth = maxNameLen + 2;
        const kindColWidth = maxKindLen + 2;

        return (
          <Box key={s.id} flexDirection="column">
            <Box>
              <Text color={isFocused ? '#E87B35' : undefined}>{pointer}</Text>
              <Text>{'   '}</Text>
              <Text color={toggleColor}>{toggle}</Text>
              <Text>{'  '}</Text>
              <Box width={nameColWidth} flexShrink={0}>
                <Text bold color={isFocused ? '#E87B35' : undefined} wrap="truncate-end">
                  {s.name}
                </Text>
              </Box>
              <Box width={kindColWidth} flexShrink={0}>
                <Text dimColor wrap="truncate-end">{originLabel(s)}</Text>
              </Box>
              <Box flexGrow={1}>
                <Text dimColor wrap="truncate-end">{s.description}</Text>
              </Box>
            </Box>
            {isFocused && (
              <Box marginLeft={7} flexDirection="column">
                {s.kind === 'hub' && (
                  <>
                    <Text dimColor wrap="truncate-end">
                      slug: {s.slug} · v{s.version} · domain {s.domain}
                    </Text>
                    {s.source && (
                      <Text dimColor wrap="truncate-end">source: {s.source}</Text>
                    )}
                    {s.allowedCapabilities && s.allowedCapabilities.length > 0 && (
                      <Text dimColor wrap="truncate-end">
                        caps: {s.allowedCapabilities.join(', ')}
                      </Text>
                    )}
                  </>
                )}
                {s.kind === 'prompt' && (
                  <Text dimColor wrap="truncate-end">file: {s.installedAt}/SKILL.md</Text>
                )}
              </Box>
            )}
          </Box>
        );
      })}

      <Box marginTop={1}>
        <Text dimColor>
          {'\u2191\u2193'} nav {'  '} Space/Enter toggle {'  '} a add (hub){'  '}
          {focused?.kind === 'hub' ? 'u uninstall  ' : ''}
          Esc close
        </Text>
      </Box>
    </Box>
  );
}
