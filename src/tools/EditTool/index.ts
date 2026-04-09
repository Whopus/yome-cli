import { mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import type { ToolDef } from '../../types.js';
import type { PermissionResult, ToolPermissionContext } from '../../permissions/types.js';
import { isContentAllowed, isContentDenied } from '../../permissions/checker.js';
import { EDIT_TOOL_NAME, getEditToolDescription } from './prompt.js';
import { getReadSnapshot, setReadSnapshot } from '../shared/fileState.js';
import {
  applyEditToContent,
  findActualString,
  getFileTimestamp,
  preserveQuoteStyle,
  readTextFileWithMetadata,
  writeTextFile,
} from '../shared/fileText.js';

const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been modified since read, either by the user or by a formatter. Read it again before attempting to write it.';

function buildDiffLines(
  fileContent: string,
  oldStr: string,
  newStr: string,
  contextLines: number = 3,
): string[] {
  const allLines = fileContent.split('\n');
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  const matchIdx = fileContent.indexOf(oldStr);
  if (matchIdx < 0) return [];
  const startLine = fileContent.slice(0, matchIdx).split('\n').length - 1;

  const result: string[] = [];

  const ctxStart = Math.max(0, startLine - contextLines);
  for (let i = ctxStart; i < startLine; i++) {
    result.push(`@@CTX:${i + 1}:${allLines[i]}`);
  }
  for (let i = 0; i < oldLines.length; i++) {
    result.push(`@@-:${startLine + i + 1}:${oldLines[i]}`);
  }
  for (let i = 0; i < newLines.length; i++) {
    result.push(`@@+:${startLine + i + 1}:${newLines[i]}`);
  }
  const afterStart = startLine + oldLines.length;
  const ctxEnd = Math.min(allLines.length, afterStart + contextLines);
  for (let i = afterStart; i < ctxEnd; i++) {
    result.push(`@@CTX:${i + 1}:${allLines[i]}`);
  }

  return result;
}

export const editTool: ToolDef = {
  name: EDIT_TOOL_NAME,
  description: getEditToolDescription(),
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file to edit' },
      old_string: { type: 'string', description: 'Exact text to find and replace' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  isReadOnly() { return false; },
  checkPermissions(input: Record<string, unknown>, ctx: ToolPermissionContext): PermissionResult {
    const filePath = (input.file_path as string) ?? '';
    if (isContentDenied(ctx, 'Edit', filePath)) {
      return { behavior: 'deny', message: `Editing denied for: ${filePath}` };
    }
    if (isContentAllowed(ctx, 'Edit', filePath)) {
      return { behavior: 'allow' };
    }
    return { behavior: 'passthrough', message: `Allow editing ${filePath}?` };
  },
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

    if (oldStr === newStr) {
      return 'Error: old_string and new_string are identical.';
    }

    if (oldStr === '') {
      try {
        const existingMeta = await readTextFileWithMetadata(filePath);
        const snapshot = getReadSnapshot(filePath);

        if (!snapshot || snapshot.isPartialView) {
          return 'Error: File has not been read yet. Read it first before writing to it.';
        }

        const lastWriteTime = await getFileTimestamp(filePath);
        if (lastWriteTime > snapshot.timestamp && existingMeta.content !== snapshot.content) {
          return `Error: ${FILE_UNEXPECTEDLY_MODIFIED_ERROR}`;
        }

        if (existingMeta.content.trim() !== '') {
          return 'Error: Cannot create new file - file already exists.';
        }

        await mkdir(dirname(filePath), { recursive: true });
        await writeTextFile(filePath, newStr, {
          encoding: existingMeta.encoding,
          lineEndings: existingMeta.lineEndings,
          hasBom: existingMeta.hasBom,
        });
        const timestamp = await getFileTimestamp(filePath);
        setReadSnapshot(filePath, {
          content: newStr.replaceAll('\r\n', '\n'),
          timestamp,
          isPartialView: false,
        });
        const lines = newStr.replaceAll('\r\n', '\n').split('\n');
        const diff = lines.map((l, i) => `@@+:${i + 1}:${l}`).join('\n');
        return `@@FILE:${filePath}\n@@NEW\n${diff}`;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') {
          throw error;
        }
      }

      await mkdir(dirname(filePath), { recursive: true });
      await writeTextFile(filePath, newStr, {
        encoding: 'utf8',
        lineEndings: 'LF',
        hasBom: false,
      });
      const timestamp = await getFileTimestamp(filePath);
      const normalizedNew = newStr.replaceAll('\r\n', '\n');
      setReadSnapshot(filePath, {
        content: normalizedNew,
        timestamp,
        isPartialView: false,
      });
      const lines = normalizedNew.split('\n');
      const diff = lines.map((l, i) => `@@+:${i + 1}:${l}`).join('\n');
      return `@@FILE:${filePath}\n@@NEW\n${diff}`;
    }

    const snapshot = getReadSnapshot(filePath);
    if (!snapshot || snapshot.isPartialView) {
      return 'Error: File has not been read yet. Read it first before writing to it.';
    }

    let meta;
    try {
      meta = await readTextFileWithMetadata(filePath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        throw error;
      }
      return `Error: File not found: ${filePath}`;
    }

    const lastWriteTime = await getFileTimestamp(filePath);
    if (lastWriteTime > snapshot.timestamp && meta.content !== snapshot.content) {
      return `Error: ${FILE_UNEXPECTEDLY_MODIFIED_ERROR}`;
    }

    const actualOldStr = findActualString(meta.content, oldStr);
    if (!actualOldStr) {
      return 'Error: old_string not found in file.';
    }

    const count = meta.content.split(actualOldStr).length - 1;
    if (count > 1 && !replaceAll) {
      return `Error: Found ${count} matches. Set replace_all=true or provide more context.`;
    }

    const adjustedNewStr = preserveQuoteStyle(oldStr, actualOldStr, newStr);
    const diffLines = buildDiffLines(meta.content, actualOldStr, adjustedNewStr);

    const updated = applyEditToContent(meta.content, actualOldStr, adjustedNewStr, replaceAll);

    await writeTextFile(filePath, updated, {
      encoding: meta.encoding,
      lineEndings: meta.lineEndings,
      hasBom: meta.hasBom,
    });

    const timestamp = await getFileTimestamp(filePath);
    setReadSnapshot(filePath, {
      content: updated,
      timestamp,
      isPartialView: false,
    });

    const addCount = adjustedNewStr.split('\n').length;
    const rmCount = actualOldStr.split('\n').length;
    return `@@FILE:${filePath}\n@@EDIT:+${addCount}:-${rmCount}\n${diffLines.join('\n')}`;
  },
};
