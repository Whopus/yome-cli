import { execSync } from 'child_process';
import { readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { loadAllSkills } from './skills/index.js';
import type { Skill } from './skills/index.js';

function safeExec(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, { cwd, timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function getFileTree(dir: string, depth = 2, prefix = ''): string {
  if (depth < 0) return '';
  const lines: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const filtered = entries.filter(
      (e) => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '__pycache__',
    );
    for (const entry of filtered.slice(0, 30)) {
      const isDir = entry.isDirectory();
      lines.push(`${prefix}${entry.name}${isDir ? '/' : ''}`);
      if (isDir && depth > 0) {
        lines.push(getFileTree(join(dir, entry.name), depth - 1, prefix + '  '));
      }
    }
    if (filtered.length > 30) lines.push(`${prefix}... (${filtered.length - 30} more)`);
  } catch { /* ignore */ }
  return lines.filter(Boolean).join('\n');
}

export function buildSystemPrompt(): string {
  const cwd = process.cwd();
  const projectName = basename(cwd);
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });

  const gitBranch = safeExec('git rev-parse --abbrev-ref HEAD', cwd);
  const gitStatus = safeExec('git status --porcelain', cwd);
  const isGit = gitBranch !== null;
  const tree = getFileTree(cwd);

  let prompt = `You are Yome, an AI coding assistant running in the user's terminal.
You help with software engineering tasks: reading code, writing code, debugging, refactoring, and running commands.

## Environment
- Date: ${dateStr}
- Working directory: ${cwd}
- Project: ${projectName}
- OS: ${process.platform} ${process.arch}
- Node: ${process.version}
`;

  if (isGit) {
    prompt += `- Git branch: ${gitBranch}\n`;
    if (gitStatus) {
      const statusLines = gitStatus.split('\n').slice(0, 20);
      prompt += `- Git status:\n${statusLines.map((l) => `  ${l}`).join('\n')}\n`;
    }
  }

  if (tree) {
    prompt += `\n## Project Structure\n\`\`\`\n${tree}\n\`\`\`\n`;
  }

  prompt += `
## Guidelines
- Use absolute paths when calling tools.
- Read files before editing them.
- Read existing files before overwriting them with Write.
- Be concise in responses.
- When editing code, preserve the existing style and patterns.
- NEVER wrap your response in \`\`\`markdown fences. Output markdown directly — the terminal renders it natively.
- Verify changes work before reporting completion.
- Never expose secrets or API keys.

## Available Tools
You have these tools: Read, Edit, Write, Bash, Glob, Grep, LS.
- Use Read to inspect file contents with line numbers. Prefer reading only the relevant section of large files.
- Use Edit for targeted updates to existing files after reading them.
- Use Write for new files or complete rewrites, not small incremental edits.
- Use Bash to run shell commands.
- Use Glob to find files by pattern.
- Use Grep to search file contents.
- Use LS to list directory contents.
`;

  const skills = loadAllSkills();
  if (skills.length > 0) {
    prompt += buildSkillsSection(skills);
  }

  return prompt;
}

function buildSkillsSection(skills: Skill[]): string {
  let section = `\n## Available Skills\nThe user can invoke skills with \`/skill-name [args]\`. You can also invoke them when appropriate.\n\n`;
  for (const skill of skills) {
    section += `### /${skill.name}\n`;
    section += `${skill.description}\n`;
    if (skill.whenToUse) section += `When to use: ${skill.whenToUse}\n`;
    if (skill.argumentHint) section += `Usage: /${skill.name} ${skill.argumentHint}\n`;
    section += `Source: ${skill.source}\n\n`;
  }
  return section;
}
