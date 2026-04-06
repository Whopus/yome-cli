import { readFile, stat } from 'fs/promises';
import { resolve } from 'path';
import type { ToolDef } from '../types.js';

function addLineNumbers(content: string, startLine: number): string {
  return content
    .split('\n')
    .map((line, i) => `${startLine + i}\t${line}`)
    .join('\n');
}

export const readTool: ToolDef = {
  name: 'Read',
  description: 'Read the contents of a file. Supports offset and limit for large files.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file to read' },
      offset: { type: 'number', description: 'Line number to start reading from (1-based). Default: 1' },
      limit: { type: 'number', description: 'Maximum number of lines to read. Default: 2000' },
    },
    required: ['file_path'],
  },
  isReadOnly() { return true; },
  validateInput(input) {
    if (typeof input.file_path !== 'string' || !input.file_path.trim()) {
      return { valid: false, error: 'file_path is required' };
    }
    return { valid: true };
  },
  getPath(input) { return input.file_path as string | undefined; },
  async execute(input) {
    const filePath = resolve(input.file_path as string);
    const offset = Math.max(1, (input.offset as number) || 1);
    const limit = (input.limit as number) || 2000;

    try {
      await stat(filePath);
    } catch {
      return `Error: File not found: ${filePath}`;
    }

    const raw = await readFile(filePath, 'utf-8');
    const lines = raw.split('\n');
    const totalLines = lines.length;
    const startIdx = offset - 1;
    const slice = lines.slice(startIdx, startIdx + limit);

    const numbered = addLineNumbers(slice.join('\n'), offset);
    let result = numbered;

    if (startIdx + limit < totalLines) {
      result += `\n\n[Showing lines ${offset}-${startIdx + limit} of ${totalLines} total]`;
    }

    return result;
  },
};
