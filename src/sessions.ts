import { readFileSync, writeFileSync, mkdirSync, readdirSync, appendFileSync, statSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import type { AgentMessage } from './types.js';

const SESSIONS_DIR = join(homedir(), '.yome', 'projects');

export interface SessionEntry {
  type: 'message' | 'title';
  timestamp: string;
  sessionId: string;
  message?: AgentMessage;
  title?: string;
}

export interface SessionInfo {
  sessionId: string;
  title: string;
  firstPrompt: string;
  lastModified: Date;
  messageCount: number;
}

function sanitizePath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

function getProjectSessionDir(): string {
  const cwd = process.cwd();
  const dir = join(SESSIONS_DIR, sanitizePath(cwd));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function getSessionFilePath(sessionId: string): string {
  return join(getProjectSessionDir(), `${sessionId}.jsonl`);
}

export function createSessionId(): string {
  return randomUUID();
}

export function appendMessage(sessionId: string, message: AgentMessage): void {
  const entry: SessionEntry = {
    type: 'message',
    timestamp: new Date().toISOString(),
    sessionId,
    message,
  };
  appendFileSync(getSessionFilePath(sessionId), JSON.stringify(entry) + '\n', 'utf-8');
}

export function setSessionTitle(sessionId: string, title: string): void {
  const entry: SessionEntry = {
    type: 'title',
    timestamp: new Date().toISOString(),
    sessionId,
    title,
  };
  appendFileSync(getSessionFilePath(sessionId), JSON.stringify(entry) + '\n', 'utf-8');
}

export function loadSessionMessages(sessionId: string): AgentMessage[] {
  const filePath = getSessionFilePath(sessionId);
  try {
    const content = readFileSync(filePath, 'utf-8').trim();
    if (!content) return [];
    const messages: AgentMessage[] = [];
    for (const line of content.split('\n')) {
      try {
        const entry: SessionEntry = JSON.parse(line);
        if (entry.type === 'message' && entry.message) {
          messages.push(entry.message);
        }
      } catch { /* skip malformed lines */ }
    }
    return messages;
  } catch {
    return [];
  }
}

function readLiteMetadata(filePath: string): { firstPrompt: string; title: string; messageCount: number } {
  let firstPrompt = '';
  let title = '';
  let messageCount = 0;
  try {
    const content = readFileSync(filePath, 'utf-8').trim();
    if (!content) return { firstPrompt, title, messageCount };
    for (const line of content.split('\n')) {
      try {
        const entry: SessionEntry = JSON.parse(line);
        if (entry.type === 'message' && entry.message) {
          messageCount++;
          if (!firstPrompt && entry.message.role === 'user') {
            const text = typeof entry.message.content === 'string'
              ? entry.message.content
              : entry.message.content
                  .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                  .map((b) => b.text)
                  .join(' ');
            firstPrompt = text.slice(0, 100);
          }
        } else if (entry.type === 'title' && entry.title) {
          title = entry.title;
        }
      } catch { /* skip */ }
    }
  } catch { /* file read error */ }
  return { firstPrompt, title, messageCount };
}

export function listSessions(): SessionInfo[] {
  const dir = getProjectSessionDir();
  const sessions: SessionInfo[] = [];
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    for (const file of files) {
      const filePath = join(dir, file);
      const sessionId = basename(file, '.jsonl');
      const stat = statSync(filePath);
      const { firstPrompt, title, messageCount } = readLiteMetadata(filePath);
      if (messageCount === 0) continue;
      sessions.push({
        sessionId,
        title: title || firstPrompt || '(untitled)',
        firstPrompt,
        lastModified: stat.mtime,
        messageCount,
      });
    }
  } catch { /* dir doesn't exist yet */ }
  sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return sessions;
}
