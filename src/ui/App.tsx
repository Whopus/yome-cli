import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Agent } from '../agent.js';
import { getVersion, loadModelEntries } from '../config.js';
import type { ModelEntry } from '../config.js';
import { isSkillDisabled, isAgentDisabled, toggleSkill, toggleAgent } from '../toggleState.js';
import { addPermissionRuleToUserSettings } from '../permissions/loader.js';
import { serializeRuleValue } from '../permissions/ruleParser.js';
import { MessageList, getToolLabel, getToolDetail } from './MessageList.js';
import { InputBar } from './InputBar.js';
import type { SlashCommand } from './InputBar.js';
import { Banner } from './Banner.js';
import { AgentPicker } from './AgentPicker.js';
import { ModelPicker } from './ModelPicker.js';
import { SessionPicker } from './SessionPicker.js';
import { PermissionPrompt } from './PermissionPrompt.js';
import { TogglePicker } from './TogglePicker.js';
import { listSessions } from '../sessions.js';
import type { ToggleItem } from './TogglePicker.js';
import type { Message } from './MessageList.js';
import type { YomeConfig } from '../config.js';
import type { PermissionMode } from '../permissions/types.js';
import type { PastedImage } from '../utils/imagePaste.js';
import { getImageFromClipboard } from '../utils/imagePaste.js';
import type { ImageBlock } from '../types.js';

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
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showSkillsPicker, setShowSkillsPicker] = useState(false);
  const [showAgentsPicker, setShowAgentsPicker] = useState(false);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [currentModelDisplay, setCurrentModelDisplay] = useState<string | undefined>(config.model);
  const [pendingPermission, setPendingPermission] = useState<{
    toolName: string;
    message: string;
    detail: string;
    resolve: (allowed: boolean) => void;
  } | null>(null);
  const pendingPermissionRef = useRef(pendingPermission);
  pendingPermissionRef.current = pendingPermission;
  const [pickerVersion, setPickerVersion] = useState(0);
  const [usage, setUsage] = useState({ inputTokens: 0, outputTokens: 0 });
  const [agent] = useState(() => new Agent(config));
  const [loopName, setLoopName] = useState(() => agent.getCurrentLoopName());
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => agent.getPermissionContext().mode);
  const [pendingImages, setPendingImages] = useState<PastedImage[]>([]);
  const isFirstMessage = useRef(true);
  const version = getVersion();

  const handleSubmit = useCallback(
    async (text: string) => {
      if ((!text.trim() && pendingImages.length === 0) || isRunning) return;
      const prompt = text.trim();
      setInputValue('');

      // /new — reset context and start fresh
      if (prompt === '/new') {
        agent.resetContext();
        setMessages([]);
        setStreamText('');
        setUsage({ inputTokens: 0, outputTokens: 0 });
        isFirstMessage.current = true;
        return;
      }

      // /login — mock login command
      if (prompt === '/login') {
        setMessages((prev) => [...prev, { type: 'text', content: '🔒 Login requested. This is a mock implementation.' }]);
        setMessages((prev) => [...prev, { type: 'text', content: 'Enter your credentials (mock):' }]);
        setMessages((prev) => [...prev, { type: 'text', content: '• Username: `user@example.com`' }]);
        setMessages((prev) => [...prev, { type: 'text', content: '• Password: `••••••••`' }]);
        setMessages((prev) => [...prev, { type: 'text', content: '✅ Login successful! You are now authenticated.' }]);
        return;
      }

      // /sessions — open session picker
      if (prompt === '/sessions') {
        setShowSessionPicker(true);
        return;
      }

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

      // /model — open model picker
      if (prompt === '/model') {
        setShowModelPicker(true);
        return;
      }

      const images = [...pendingImages];
      setPendingImages([]);

      const imageLabel = images.length > 0
        ? ` [${images.length} image${images.length > 1 ? 's' : ''}]`
        : '';
      setMessages((prev) => [...prev, { type: 'user', content: (prompt || '(image)') + imageLabel }]);
      setStreamText('');
      setIsRunning(true);

      // Persist user message to session
      agent.persistMessage({ role: 'user', content: prompt || '(image)' });
      if (isFirstMessage.current) {
        agent.persistTitle(prompt.slice(0, 100) || '(image)');
        isFirstMessage.current = false;
      }

      let currentText = '';

      await agent.run(prompt || 'What is in this image?', {
        async onAskPermission(toolName, message, input) {
          const detail = toolName === 'Bash'
            ? (input.command as string) ?? ''
            : (input.file_path as string) ?? '';
          return new Promise<boolean>((resolve) => {
            setPendingPermission({ toolName, message, detail, resolve });
          });
        },
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
            agent.persistMessage({ role: 'assistant', content: currentText });
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
      }, images.length > 0 ? images : undefined);
    },
    [agent, isRunning, pendingImages],
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

  const handleModelSelect = useCallback(
    (entry: ModelEntry) => {
      agent.switchModel(entry);
      setCurrentModelDisplay(entry.displayName);
      setShowModelPicker(false);
      setMessages((prev) => [
        ...prev,
        { type: 'text', content: `Switched to model **${entry.displayName}** (${entry.model}).` },
      ]);
    },
    [agent],
  );

  const handleModelCancel = useCallback(() => {
    setShowModelPicker(false);
  }, []);

  const handleSessionSelect = useCallback(
    (sessionId: string) => {
      agent.restoreSession(sessionId);
      const restored = agent.getMessages();
      const uiMessages: Message[] = [];
      for (const msg of restored) {
        if (msg.role === 'user') {
          const text = typeof msg.content === 'string'
            ? msg.content
            : msg.content
                .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                .map((b) => b.text)
                .join(' ');
          uiMessages.push({ type: 'user', content: text });
        } else if (msg.role === 'assistant') {
          const text = typeof msg.content === 'string'
            ? msg.content
            : msg.content
                .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                .map((b) => b.text)
                .join(' ');
          if (text) uiMessages.push({ type: 'text', content: text });
        }
      }
      setMessages(uiMessages);
      setStreamText('');
      setUsage({ inputTokens: 0, outputTokens: 0 });
      isFirstMessage.current = false;
      setShowSessionPicker(false);
    },
    [agent],
  );

  const handleSessionCancel = useCallback(() => {
    setShowSessionPicker(false);
  }, []);

  const handlePermissionAllow = useCallback(() => {
    if (pendingPermissionRef.current) {
      pendingPermissionRef.current.resolve(true);
      setPendingPermission(null);
    }
  }, []);

  const handlePermissionDeny = useCallback(() => {
    if (pendingPermissionRef.current) {
      pendingPermissionRef.current.resolve(false);
      setPendingPermission(null);
    }
  }, []);

  const handlePermissionAlwaysAllow = useCallback(() => {
    if (pendingPermissionRef.current) {
      const { toolName } = pendingPermissionRef.current;
      addPermissionRuleToUserSettings(toolName, 'allow');
      // Also update the in-memory context so it takes effect immediately
      agent.switchPermissionMode(agent.getPermissionContext().mode); // triggers re-init won't help — we need to reload
      pendingPermissionRef.current.resolve(true);
      setPendingPermission(null);
      setMessages((prev) => [
        ...prev,
        { type: 'text', content: `**${toolName}** added to always-allow rules.` },
      ]);
    }
  }, [agent]);

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

  const isPickerOpen = showAgentPicker || showModelPicker || showSkillsPicker || showAgentsPicker || showSessionPicker || pendingPermission !== null;

  const PERMISSION_CYCLE: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions'];

  const handleImagePaste = useCallback(() => {
    const image = getImageFromClipboard();
    if (image) {
      setPendingImages((prev) => [...prev, image]);
    }
  }, []);

  useInput((input, key) => {
    if (!isPickerOpen && key.ctrl && input === 'c') exit();
    if (!isPickerOpen && !isRunning && key.ctrl && input === 'v') {
      handleImagePaste();
    }
    if (!isPickerOpen && !isRunning && key.shift && key.tab) {
      const idx = PERMISSION_CYCLE.indexOf(permissionMode);
      const next = PERMISSION_CYCLE[(idx + 1) % PERMISSION_CYCLE.length]!;
      agent.switchPermissionMode(next);
      setPermissionMode(next);
    }
  });

  const slashCommands: SlashCommand[] = React.useMemo(() => {
    const builtIn: SlashCommand[] = [
      { name: 'new', description: 'Start a new conversation (reset context)' },
      { name: 'login', description: 'Mock login command (for demonstration)' },
      { name: 'sessions', description: 'Browse and continue previous sessions' },
      { name: 'model', description: 'Switch model' },
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

      {showModelPicker && (
        <Box marginTop={1}>
          <ModelPicker
            models={loadModelEntries()}
            currentModel={agent.getConfig().model}
            onSelect={handleModelSelect}
            onCancel={handleModelCancel}
          />
        </Box>
      )}

      {showSessionPicker && (
        <Box marginTop={1}>
          <SessionPicker
            sessions={listSessions()}
            onSelect={handleSessionSelect}
            onCancel={handleSessionCancel}
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

      {pendingPermission && (
        <PermissionPrompt
          toolName={pendingPermission.toolName}
          message={pendingPermission.message}
          detail={pendingPermission.detail}
          onAllow={handlePermissionAllow}
          onDeny={handlePermissionDeny}
          onAlwaysAllow={handlePermissionAlwaysAllow}
        />
      )}

      {!isRunning && !isPickerOpen && (
        <InputBar
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSubmit}
          model={currentModelDisplay}
          loopName={loopName}
          slashCommands={slashCommands}
          permissionMode={permissionMode}
          imageCount={pendingImages.length}
        />
      )}
    </Box>
  );
}
