import { readdir, stat } from 'fs/promises';
import { resolve, join } from 'path';
import type { ToolDef } from '../types.js';

export const lsTool: ToolDef = {
  name: 'LS',
  description: 'List contents of a directory.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path to list (default: cwd)' },
    },
  },
  isReadOnly() { return true; },
  getPath(input) { return input.path as string | undefined; },
  async execute(input) {
    const dirPath = resolve((input.path as string) || process.cwd());

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const lines: string[] = [];

      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
        const fullPath = join(dirPath, entry.name);
        try {
          const s = await stat(fullPath);
          const size = entry.isDirectory() ? '' : formatSize(s.size);
          const type = entry.isDirectory() ? 'd' : '-';
          lines.push(`${type}  ${size.padStart(8)}  ${entry.name}${entry.isDirectory() ? '/' : ''}`);
        } catch {
          lines.push(`?           ${entry.name}`);
        }
      }

      return lines.length > 0 ? lines.join('\n') : '(empty directory)';
    } catch {
      return `Error: Cannot read directory: ${dirPath}`;
    }
  },
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}
