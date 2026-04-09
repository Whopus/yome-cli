import fg from 'fast-glob';
import { resolve } from 'path';
import type { ToolDef } from '../../types.js';

export const globTool: ToolDef = {
  name: 'Glob',
  description: 'Find files matching a glob pattern. Returns file paths.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern to match (e.g. "**/*.ts")' },
      path: { type: 'string', description: 'Directory to search in (default: cwd)' },
    },
    required: ['pattern'],
  },
  isReadOnly() { return true; },
  validateInput(input) {
    if (typeof input.pattern !== 'string' || !input.pattern.trim()) {
      return { valid: false, error: 'pattern is required' };
    }
    return { valid: true };
  },
  getPath(input) { return input.path as string | undefined; },
  async execute(input) {
    const pattern = input.pattern as string;
    const searchPath = resolve((input.path as string) || process.cwd());

    const files = await fg(pattern, {
      cwd: searchPath,
      ignore: ['**/node_modules/**', '**/.git/**'],
      dot: true,
      onlyFiles: true,
      absolute: false,
    });

    files.sort();
    const limit = 100;
    const truncated = files.length > limit;
    const shown = truncated ? files.slice(0, limit) : files;

    if (shown.length === 0) return 'No files found';

    let result = `Found ${files.length} file(s)\n${shown.join('\n')}`;
    if (truncated) result += '\n(Results truncated. Use a more specific pattern.)';
    return result;
  },
};
