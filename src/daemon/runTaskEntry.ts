// Entry point for `yome __run-task <id>`.
//
// The cron trigger spawns a child process per fire, with this command.
// We load the task from tasks.json, build a config (same as interactive
// `yome`), call runDaemonTask, then exit with 0/1 based on success.
//
// This file is intentionally tiny — all business logic lives in
// runner.ts. Keeping the entry small means the cold-start cost per fire
// is just "load Node + parse tasks.json + bootstrap Agent".

import { resolveConfig, loadModelEntries, modelEntryToConfig } from '../config.js';
import { getTask } from './taskStore.js';
import { runDaemonTask } from './runner.js';
import { buildEnvHint } from './envHint.js';

export async function runTaskById(taskId: string): Promise<number> {
  const t = getTask(taskId);
  if (!t) {
    console.error(`__run-task: no such task: ${taskId}`);
    return 1;
  }

  // Resolve the LLM config. Same precedence as interactive `yome`:
  //   stored config → first customModels entry → bail.
  let config = resolveConfig({});
  if (!config.apiKey) {
    const entries = loadModelEntries();
    if (entries.length > 0) config = modelEntryToConfig(entries[0]);
  }
  if (!config.apiKey) {
    console.error('__run-task: no API key — set one via `yome --key sk-...` first');
    return 1;
  }

  // Compose the final user prompt by stacking three layers, in order:
  //   1. envHint     — auto-detected local tools + per-OS gotchas, only in daemon mode.
  //   2. extra       — runtime context injected by file/calendar triggers via env var.
  //   3. t.prompt    — what the user originally wrote in `yome cron add "..."`.
  // Each layer is independent: if the env hint detects nothing, it returns
  // '' and is filtered out so we don't waste tokens on an empty header.
  const envHint = buildEnvHint();
  const extra = process.env.YOME_TASK_EXTRA_CONTEXT;
  const promptWithContext = [envHint, extra?.trim(), t.prompt]
    .filter((s): s is string => !!s && s.length > 0)
    .join('\n\n');

  const result = await runDaemonTask(config, {
    taskId: t.id,
    prompt: promptWithContext,
    cwd: t.cwd,
    autoAllow: t.autoAllow,
    autoDeny: t.autoDeny,
  });

  // Brief stdout summary — the audit jsonl in ~/.yome/cron/logs/<id>/
  // has the full transcript. The parent process (scheduler) captures
  // stdout and stuffs the tail into the run_end log entry, so this
  // doubles as a coarse status line.
  console.log(JSON.stringify({
    taskId: t.id,
    ok: result.ok,
    toolCalls: result.toolCalls,
    durationMs: result.durationMs,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    error: result.error,
    finalTextHead: result.finalText.slice(0, 200),
    logFile: result.logFile,
  }));

  return result.ok ? 0 : 1;
}
