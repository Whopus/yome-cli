import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Agent } from '../agent.js';
import { getVersion } from '../config.js';
import { isSkillDisabled, isAgentDisabled, toggleSkill, toggleAgent } from '../toggleState.js';
import { MessageList, getToolLabel, getToolDetail } from './MessageList.js';
import { InputBar } from './InputBar.js';
import type { SlashCommand } from './InputBar.js';
import { Banner } from './Banner.js';
import { AgentPicker } from './AgentPicker.js';
import { TogglePicker } from './TogglePicker.js';
import type { ToggleItem } from './TogglePicker.js';
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
  const [showSkillsPicker, setShowSkillsPicker] = useState(false);
  const [showAgentsPicker, setShowAgentsPicker] = useState(false);
  const [pickerVersion, setPickerVersion] = useState(0);
  const [usage, setUsage] = useState({ inputTokens: 0, outputTokens: 0 });
  const [agent] = useState(() => new Agent(config));
  const [loopName, setLoopName] = useState(() => agent.getCurrentLoopName());
  const version = getVersion();

  const handleSubmit = useCallback(
    async (text: string) => {
      if (!text.trim() || isRunning) return;
      const prompt = text.trim();
      setInputValue('');

      // /skills — interactive toggle picker
      if (prompt === '/skills') {
        setShowSkillsPicker(true);
        setPickerVersion((v) => v + 1);
        return;
      }

      // /subagents — interactive toggle picker
      if (prompt === '/subagents') {
        setShowAgentsPicker(true);
        setPickerVersion((v) => v + 1);
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

  const buildSkillItems = useCallback((): ToggleItem[] => {
    return agent.getSkills().map((s) => ({
      name: s.name,
      description: s.description,
      source: s.source,
      enabled: !isSkillDisabled(s.name),
    }));
  }, [agent]);

  const buildAgentItems = useCallback((): ToggleItem[] => {
    return agent.getAgents().map((a) => ({
      name: a.agentType,
      description: a.whenToUse,
      source: a.source,
      enabled: !isAgentDisabled(a.agentType),
      skills: a.skills,
    }));
  }, [agent]);

  const handleSkillToggle = useCallback((name: string) => {
    const nowEnabled = toggleSkill(name);
    setPickerVersion((v) => v + 1);
    const status = nowEnabled ? 'enabled' : 'disabled';
    setMessages((prev) => [...prev, { type: 'text', content: `Skill **${name}** ${status}.` }]);
  }, []);

  const handleAgentToggle = useCallback((name: string) => {
    const nowEnabled = toggleAgent(name);
    setPickerVersion((v) => v + 1);
    const status = nowEnabled ? 'enabled' : 'disabled';
    setMessages((prev) => [...prev, { type: 'text', content: `Agent **${name}** ${status}.` }]);
  }, []);

  useEffect(() => {
    const initialPrompt = (config as any).__initialPrompt;
    if (initialPrompt) handleSubmit(initialPrompt);
  }, []);

  const isPickerOpen = showAgentPicker || showSkillsPicker || showAgentsPicker;

  useInput((input, key) => {
    if (!isPickerOpen && key.ctrl && input === 'c') exit();
  });

  const slashCommands: SlashCommand[] = React.useMemo(() => {
    const builtIn: SlashCommand[] = [
      { name: 'skills', description: 'Manage skills (enable/disable)' },
      { name: 'subagents', description: 'Manage subagents (enable/disable)' },
      { name: 'agent', description: 'Switch agent loop mode' },
    ];
    const skillItems = agent.getSkills()
      .filter((s) => !isSkillDisabled(s.name))
      .map((s) => ({ name: s.name, description: s.description }));
    return [...builtIn, ...skillItems];
  }, [agent, pickerVersion]);

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

      {showSkillsPicker && (
        <Box marginTop={1}>
          <TogglePicker
            key={`skills-${pickerVersion}`}
            title="Skills"
            items={buildSkillItems()}
            onToggle={handleSkillToggle}
            onClose={() => setShowSkillsPicker(false)}
            emptyHint={'No skills found.\n\nCreate skills in:\n  ~/.yome/skills/<name>/SKILL.md  (user)\n  .yome/skills/<name>/SKILL.md   (project)'}
          />
        </Box>
      )}

      {showAgentsPicker && (
        <Box marginTop={1}>
          <TogglePicker
            key={`agents-${pickerVersion}`}
            title="Agents"
            items={buildAgentItems()}
            onToggle={handleAgentToggle}
            onClose={() => setShowAgentsPicker(false)}
            emptyHint={'No agents found.\n\nCreate agents in:\n  ~/.yome/agents/<name>.md  (user)\n  .yome/agents/<name>.md   (project)'}
          />
        </Box>
      )}

      {!isRunning && !isPickerOpen && (
        <InputBar
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSubmit}
          model={config.model}
          loopName={loopName}
          slashCommands={slashCommands}
        />
      )}
    </Box>
  );
}
