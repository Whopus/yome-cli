import React from 'react';
import { Box, Text } from 'ink';
import { Markdown } from './Markdown.js';
import { ToolResult } from './ToolResult.js';
import { Spinner } from './Spinner.js';

const DOT = process.platform === 'darwin' ? '\u23FA' : '\u25CF';

export interface Message {
  type: 'user' | 'text' | 'tool_start' | 'tool_result' | 'error';
  content: string;
  toolName?: string;
  toolSummary?: string;
  toolLabel?: string;
  done?: boolean;
}

export function getToolLabel(name: string): string {
  const labels: Record<string, string> = {
    Read: 'Read 1 file',
    Write: 'Write file',
    Edit: 'Edit file',
    Bash: 'Run command',
    Glob: 'Find files',
    Grep: 'Search files',
    LS: 'List directory',
  };
  return labels[name] ?? name;
}

export function getToolDetail(name: string, input: Record<string, unknown>): string {
  const keys: Record<string, string> = {
    Bash: 'command', Read: 'file_path', Write: 'file_path',
    Edit: 'file_path', Glob: 'pattern', Grep: 'pattern',
  };
  const key = keys[name];
  if (key) return String(input[key] || '');
  if (name === 'LS') return String(input.path || process.cwd());
  return JSON.stringify(input).slice(0, 60);
}

function MessageItem({ msg }: { msg: Message }) {
  switch (msg.type) {
    case 'user':
      return (
        <Box marginTop={1} borderStyle="single" borderLeft borderTop={false} borderBottom={false} borderRight={false} borderColor="#E87B35">
          <Text backgroundColor="black" color="white" bold>{' ' + msg.content + ' '}</Text>
        </Box>
      );

    case 'text':
      return (
        <Box marginTop={1} marginLeft={2} flexShrink={1} flexDirection="column">
          <Markdown>{msg.content}</Markdown>
        </Box>
      );

    case 'tool_start':
      return (
        <Box flexDirection="column" marginTop={0}>
          <Box>
            <Text>{'  '}</Text>
            {!msg.done && <Spinner color="cyan" />}
            {msg.done && <Text color="green">{DOT}</Text>}
            <Text> </Text>
            <Text bold>{msg.toolLabel}</Text>
          </Box>
          {msg.toolSummary && (
            <Box>
              <Text dimColor>{'    \u21B3 '}</Text>
              <Text dimColor>{msg.toolSummary}</Text>
            </Box>
          )}
        </Box>
      );

    case 'tool_result':
      return <ToolResult name={msg.toolName || ''} result={msg.content} />;

    case 'error':
      return (
        <Box>
          <Text dimColor>{'  \u21B3 '}</Text>
          <Text color="red">{msg.content}</Text>
        </Box>
      );

    default:
      return null;
  }
}

interface MessageListProps {
  messages: Message[];
  streamText: string;
  isRunning: boolean;
}

export function MessageList({ messages, streamText, isRunning }: MessageListProps) {
  return (
    <>
      {messages.map((msg, i) => (
        <MessageItem key={i} msg={msg} />
      ))}

      {streamText && (
        <Box marginTop={1} marginLeft={2} flexShrink={1} flexDirection="column">
          <Markdown>{streamText}</Markdown>
        </Box>
      )}

      {isRunning && !streamText && (
        <Box marginTop={1} marginLeft={2}>
          <Spinner />
          <Text dimColor> Thinking\u2026</Text>
        </Box>
      )}
    </>
  );
}
