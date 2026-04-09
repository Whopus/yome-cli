import { stat } from 'fs/promises';
import { resolve } from 'path';
import type { ToolDef } from '../../types.js';
import { getReadToolDescription, MAX_LINES_TO_READ, READ_TOOL_NAME } from './prompt.js';
import { readFileInRange } from '../shared/fileText.js';
import { setReadSnapshot } from '../shared/fileState.js';

function addLineNumbers(content: string, startLine: number): string {
  return content
    .split('\n')
    .map((line, i) => `${startLine + i}\t${line}`)
    .join('\n');
}

export const readTool: ToolDef = {
  name: READ_TOOL_NAME,
  description: getReadToolDescription(),
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file to read' },
      offset: { type: 'number', description: 'Line number to start reading from (1-based)' },
      limit: { type: 'number', description: 'Maximum number of lines to read' },
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
    const limit = (input.limit as number) || MAX_LINES_TO_READ;

    try {
      await stat(filePath);
    } catch {
      return `Error: File not found: ${filePath}`;
    }

    const startIdx = offset - 1;
    const range = await readFileInRange(filePath, startIdx, limit);
    const totalLines = range.totalLines;
    const isPartialView = offset !== 1 || range.lineCount < totalLines;

    setReadSnapshot(filePath, {
      content: range.content,
      timestamp: range.mtimeMs,
      offset: isPartialView ? offset : undefined,
      limit: isPartialView ? limit : undefined,
      isPartialView,
    });

    const numbered = addLineNumbers(range.content, offset);
    let result = numbered;

    if (startIdx + limit < totalLines) {
      result += `\n\n[Showing lines ${offset}-${startIdx + limit} of ${totalLines} total]`;
    }

    return result;
  },
};
