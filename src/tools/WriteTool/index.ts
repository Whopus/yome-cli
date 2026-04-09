import { mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import type { ToolDef } from '../../types.js';
import type { PermissionResult, ToolPermissionContext } from '../../permissions/types.js';
import { isContentAllowed, isContentDenied } from '../../permissions/checker.js';
import { getWriteToolDescription, WRITE_TOOL_NAME } from './prompt.js';
import { getReadSnapshot, setReadSnapshot } from '../shared/fileState.js';
import {
  getFileTimestamp,
  readTextFileWithMetadata,
  writeTextFile,
} from '../shared/fileText.js';

const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been modified since read, either by the user or by a formatter. Read it again before attempting to write it.';

export const writeTool: ToolDef = {
  name: WRITE_TOOL_NAME,
  description: getWriteToolDescription(),
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file to write' },
      content: { type: 'string', description: 'Complete file contents to write' },
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
    return { behavior: 'passthrough', message: `Allow writing ${filePath}?` };
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

    let existingMeta: Awaited<ReturnType<typeof readTextFileWithMetadata>> | null = null;
    try {
      existingMeta = await readTextFileWithMetadata(filePath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        throw error;
      }
    }

    if (existingMeta) {
      const snapshot = getReadSnapshot(filePath);
      if (!snapshot || snapshot.isPartialView) {
        return 'Error: File has not been read yet. Read it first before writing to it.';
      }

      const lastWriteTime = await getFileTimestamp(filePath);
      if (lastWriteTime > snapshot.timestamp && existingMeta.content !== snapshot.content) {
        return `Error: ${FILE_UNEXPECTEDLY_MODIFIED_ERROR}`;
      }
    }

    await mkdir(dirname(filePath), { recursive: true });
    await writeTextFile(filePath, content, existingMeta
      ? {
          encoding: existingMeta.encoding,
          lineEndings: existingMeta.lineEndings,
          hasBom: existingMeta.hasBom,
        }
      : {
          encoding: 'utf8',
          lineEndings: 'LF',
          hasBom: false,
        });

    const normalizedContent = content.replaceAll('\r\n', '\n');
    const timestamp = await getFileTimestamp(filePath);
    setReadSnapshot(filePath, {
      content: normalizedContent,
      timestamp,
      isPartialView: false,
    });

    const lines = normalizedContent.split('\n');
    const diff = lines.map((l, i) => `@@+:${i + 1}:${l}`).join('\n');
    return `@@FILE:${filePath}\n@@NEW:${lines.length} lines\n${diff}`;
  },
};
