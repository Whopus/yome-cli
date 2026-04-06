import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Agent } from '../agent.js';
import { getVersion } from '../config.js';
import { MessageList, getToolLabel, getToolDetail } from './MessageList.js';
import { InputBar } from './InputBar.js';
import { Banner } from './Banner.js';
import { AgentPicker } from './AgentPicker.js';
import type { Message } from './MessageList.js';
import type { YomeConfig } from '../config.js';

interface AppProps {
  config: YomeConfig;
}

export function App({ config }: AppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamText, setStreamText] = useState('');
  const [inputValue, setInputValue] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [usage, setUsage] = useState({ inputTokens: 0, outputTokens: 0 });
  const [agent] = useState(() => new Agent(config));
  const [loopName, setLoopName] = useState(() => agent.getCurrentLoopName());
  const version = getVersion();

  const handleSubmit = useCallback(
    async (text: string) => {
      if (!text.trim() || isRunning) return;
      const prompt = text.trim();
      setInputValue('');

      // /skills
      if (prompt === '/skills') {
        const skills = agent.getSkills();
        const content = skills.length === 0
          ? 'No skills loaded.\n\nCreate skills in:\n- `~/.yome/skills/<name>/SKILL.md` (user)\n- `.yome/skills/<name>/SKILL.md` (project)'
          : `**Available Skills** (${skills.length})\n\n${skills.map((s) => `- **/${s.name}** -- ${s.description} _(${s.source})_`).join('\n')}`;
        setMessages((prev) => [...prev, { type: 'user', content: prompt }, { type: 'text', content }]);
        return;
      }

      // /agent — open interactive picker
      if (prompt === '/agent') {
        setShowAgentPicker(true);
        return;
      }

      setMessages((prev) => [...prev, { type: 'user', content: prompt }]);
      setStreamText('');
      setIsRunning(true);

      let currentText = '';

      await agent.run(prompt, {
        onTextDelta(delta) {
          currentText += delta;
          setStreamText(currentText);
        },
        onToolUse(name, input) {
          if (currentText) {
            setMessages((prev) => [...prev, { type: 'text', content: currentText }]);
            currentText = '';
            setStreamText('');
          }
          setMessages((prev) => [
            ...prev,
            {
              type: 'tool_start',
              content: name,
              toolName: name,
              toolLabel: getToolLabel(name),
              toolSummary: getToolDetail(name, input),
            },
          ]);
        },
        onToolResult(name, result) {
          setMessages((prev) => {
            const updated = [...prev];
            for (let i = updated.length - 1; i >= 0; i--) {
              if (updated[i].type === 'tool_start' && updated[i].toolName === name && !updated[i].done) {
                updated[i] = { ...updated[i], done: true };
                break;
              }
            }
            return [...updated, { type: 'tool_result', content: result, toolName: name }];
          });
        },
        onDone(u) {
          if (currentText) {
            setMessages((prev) => [...prev, { type: 'text', content: currentText }]);
            setStreamText('');
          }
          setUsage((prev) => ({
            inputTokens: prev.inputTokens + u.inputTokens,
            outputTokens: prev.outputTokens + u.outputTokens,
          }));
          setIsRunning(false);
        },
        onError(err) {
          setMessages((prev) => [...prev, { type: 'error', content: err.message }]);
          setIsRunning(false);
        },
      });
    },
    [agent, isRunning],
  );

  const handleAgentSelect = useCallback(
    (name: string) => {
      agent.switchLoop(name);
      setLoopName(name);
      setShowAgentPicker(false);
      setMessages((prev) => [
        ...prev,
        { type: 'text', content: `Switched to **${name}** agent loop.` },
      ]);
    },
    [agent],
  );

  const handleAgentCancel = useCallback(() => {
    setShowAgentPicker(false);
  }, []);

  useEffect(() => {
    const initialPrompt = (config as any).__initialPrompt;
    if (initialPrompt) handleSubmit(initialPrompt);
  }, []);

  useInput((input, key) => {
    if (!showAgentPicker && key.ctrl && input === 'c') exit();
  });

  const totalTokens = usage.inputTokens + usage.outputTokens;

  return (
    <Box flexDirection="column" paddingX={1}>
      {messages.length === 0 && !isRunning && !showAgentPicker && <Banner />}

      {messages.length > 0 && (
        <Box marginBottom={1} marginTop={1}>
          <Text bold color="magenta">{'> '}</Text>
          <Text bold>Yome</Text>
          <Text dimColor> v{version}</Text>
          {totalTokens > 0 && (
            <Text dimColor> {'\u00B7'} {(totalTokens / 1000).toFixed(1)}k tokens</Text>
          )}
        </Box>
      )}

      <MessageList messages={messages} streamText={streamText} isRunning={isRunning} />

      {showAgentPicker && (
        <Box marginTop={1}>
          <AgentPicker
            options={agent.getAvailableLoops().map((l) => ({
              name: l.name,
              description: l.description,
              active: l.name === loopName,
            }))}
            onSelect={handleAgentSelect}
            onCancel={handleAgentCancel}
          />
        </Box>
      )}

      {!isRunning && !showAgentPicker && (
        <InputBar
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSubmit}
          model={config.model}
          loopName={loopName}
        />
      )}
    </Box>
  );
}
