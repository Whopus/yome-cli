import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import type { ToolDef } from '../types.js';

function buildDiffLines(
  fileContent: string,
  oldStr: string,
  newStr: string,
  contextLines: number = 3,
): string[] {
  const allLines = fileContent.split('\n');
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  // Find where old_string starts in the file
  const matchIdx = fileContent.indexOf(oldStr);
  if (matchIdx < 0) return [];
  const startLine = fileContent.slice(0, matchIdx).split('\n').length - 1;

  const result: string[] = [];

  // Context before
  const ctxStart = Math.max(0, startLine - contextLines);
  for (let i = ctxStart; i < startLine; i++) {
    result.push(`@@CTX:${i + 1}:${allLines[i]}`);
  }
  // Removed lines
  for (let i = 0; i < oldLines.length; i++) {
    result.push(`@@-:${startLine + i + 1}:${oldLines[i]}`);
  }
  // Added lines
  for (let i = 0; i < newLines.length; i++) {
    result.push(`@@+:${startLine + i + 1}:${newLines[i]}`);
  }
  // Context after
  const afterStart = startLine + oldLines.length;
  const ctxEnd = Math.min(allLines.length, afterStart + contextLines);
  for (let i = afterStart; i < ctxEnd; i++) {
    result.push(`@@CTX:${i + 1}:${allLines[i]}`);
  }

  return result;
}

export const editTool: ToolDef = {
  name: 'Edit',
  description:
    'Edit a file by replacing old_string with new_string. The old_string must be unique in the file (or use replace_all). To create a new file, use empty old_string and provide new_string as the full content.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file to edit' },
      old_string: { type: 'string', description: 'The exact text to find and replace' },
      new_string: { type: 'string', description: 'The replacement text' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  isReadOnly() { return false; },
  validateInput(input) {
    if (typeof input.file_path !== 'string' || !input.file_path.trim()) {
      return { valid: false, error: 'file_path is required' };
    }
    return { valid: true };
  },
  getPath(input) { return input.file_path as string | undefined; },
  async execute(input) {
    const filePath = resolve(input.file_path as string);
    const oldStr = input.old_string as string;
    const newStr = input.new_string as string;
    const replaceAll = (input.replace_all as boolean) ?? false;

    if (oldStr === '') {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, newStr, 'utf-8');
      const lines = newStr.split('\n');
      const diff = lines.map((l, i) => `@@+:${i + 1}:${l}`).join('\n');
      return `@@FILE:${filePath}\n@@NEW\n${diff}`;
    }

    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      return `Error: File not found: ${filePath}`;
    }

    const count = content.split(oldStr).length - 1;
    if (count === 0) {
      return `Error: old_string not found in file.`;
    }
    if (count > 1 && !replaceAll) {
      return `Error: Found ${count} matches. Set replace_all=true or provide more context.`;
    }

    // Build diff BEFORE writing (need original content for context)
    const diffLines = buildDiffLines(content, oldStr, newStr);

    const updated = replaceAll
      ? content.replaceAll(oldStr, newStr)
      : content.replace(oldStr, newStr);

    await writeFile(filePath, updated, 'utf-8');

    const addCount = newStr.split('\n').length;
    const rmCount = oldStr.split('\n').length;
    return `@@FILE:${filePath}\n@@EDIT:+${addCount}:-${rmCount}\n${diffLines.join('\n')}`;
  },
};
