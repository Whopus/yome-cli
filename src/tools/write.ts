import { writeFile, mkdir, readFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import type { ToolDef } from '../types.js';
import type { PermissionResult, ToolPermissionContext } from '../permissions/types.js';
import { isContentAllowed, isContentDenied } from '../permissions/checker.js';

export const writeTool: ToolDef = {
  name: 'Write',
  description: 'Create a new file with the given content. Creates parent directories if needed.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path for the new file' },
      content: { type: 'string', description: 'Content to write to the file' },
    },
    required: ['file_path', 'content'],
  },
  isReadOnly() { return false; },
  checkPermissions(input: Record<string, unknown>, ctx: ToolPermissionContext): PermissionResult {
    const filePath = (input.file_path as string) ?? '';
    if (isContentDenied(ctx, 'Write', filePath)) {
      return { behavior: 'deny', message: `Writing denied for: ${filePath}` };
    }
    if (isContentAllowed(ctx, 'Write', filePath)) {
      return { behavior: 'allow' };
    }
    return { behavior: 'passthrough', message: `Allow creating ${filePath}?` };
  },
  validateInput(input) {
    if (typeof input.file_path !== 'string' || !input.file_path.trim()) {
      return { valid: false, error: 'file_path is required' };
    }
    if (typeof input.content !== 'string') {
      return { valid: false, error: 'content is required' };
    }
    return { valid: true };
  },
  getPath(input) { return input.file_path as string | undefined; },
  async execute(input) {
    const filePath = resolve(input.file_path as string);
    const content = input.content as string;

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf-8');

    const lines = content.split('\n');
    const diff = lines.map((l, i) => `@@+:${i + 1}:${l}`).join('\n');
    return `@@FILE:${filePath}\n@@NEW:${lines.length} lines\n${diff}`;
  },
};
