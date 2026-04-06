import { spawn } from 'child_process';
import { resolve } from 'path';
import type { ToolDef } from '../types.js';

function runGrep(args: string[], cwd: string): Promise<string> {
  return new Promise((resolveP) => {
    const proc = spawn(args[0], args.slice(1), {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15_000,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 1 && !stdout.trim()) {
        resolveP('No matches found');
      } else if (code !== 0 && code !== 1) {
        resolveP(`Error: ${stderr || `exit code ${code}`}`);
      } else {
        resolveP(stdout.trim() || 'No matches found');
      }
    });

    proc.on('error', (err) => {
      resolveP(`Error: ${err.message}`);
    });
  });
}

function hasRipgrep(): Promise<boolean> {
  return new Promise((res) => {
    const proc = spawn('which', ['rg']);
    proc.on('close', (code) => res(code === 0));
    proc.on('error', () => res(false));
  });
}

export const grepTool: ToolDef = {
  name: 'Grep',
  description: 'Search file contents using grep (or ripgrep if available). Returns matching lines with file paths.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      path: { type: 'string', description: 'File or directory to search in (default: cwd)' },
      case_insensitive: { type: 'boolean', description: 'Case insensitive search (default: false)' },
      glob: { type: 'string', description: 'File glob filter (e.g. "*.ts")' },
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
    const caseInsensitive = input.case_insensitive as boolean;
    const globFilter = input.glob as string;

    // Use array args (no shell interpolation = no injection)
    const useRg = await hasRipgrep();

    let args: string[];
    if (useRg) {
      args = ['rg', '--hidden', '-n', '--max-columns', '500', '--glob', '!.git', '--glob', '!node_modules'];
      if (caseInsensitive) args.push('-i');
      if (globFilter) args.push('--glob', globFilter);
      args.push(pattern, searchPath);
    } else {
      args = ['grep', '-rn'];
      if (caseInsensitive) args.push('-i');
      args.push(pattern, searchPath);
    }

    const output = await runGrep(args, searchPath);

    const lines = output.split('\n');
    const limit = 200;
    if (lines.length > limit) {
      return lines.slice(0, limit).join('\n') + `\n\n[Showing ${limit} of ${lines.length} matches]`;
    }
    return output;
  },
};
