// Dispatch incoming rpc:cal-request frames to local Linux tools and
// send the result back as rpc:cal-response.
//
// Mirror of the macOS path in Yome/YomeApp.swift::BridgeMessage.request,
// which routes by `parsed.domain` to a per-domain bridge. Here on Linux:
//
//   domain=bash → spawn /bin/sh and stream output
//   domain=fs   → file system operations (mkdir / ls / cat / write)
//
// Stage A intentionally ships only 'bash' + 'fs' to prove the pipe.
// Other domains (git / docker / k8s / systemd / pkg / log / svc / net)
// are advertised as capabilities but currently return a friendly
// "not implemented yet" so the Cloud agent can fall back gracefully.

import { spawn } from 'child_process';
import { promises as fsp } from 'fs';
import { join, resolve as resolvePath, isAbsolute } from 'path';
import type { PartyKitClient } from './partykit-client.js';
import type { WsRpcRequest, WsRpcResponse } from './types.js';

const BASH_TIMEOUT_MS = 60_000;
const MAX_STDOUT_CHARS = 64_000;

export interface RpcHandlerOpts {
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
}

export class RpcHandler {
  private detach: (() => void) | null = null;
  constructor(private client: PartyKitClient, private opts: RpcHandlerOpts = {}) {}

  start(): void {
    this.detach = this.client.onMessage((frame) => {
      let parsed: unknown;
      try { parsed = JSON.parse(frame); } catch { return; }
      const obj = parsed as { type?: string };
      if (obj?.type !== 'rpc:cal-request') return;
      const req = obj as unknown as WsRpcRequest;
      // Don't await: each RPC handled independently so a slow bash
      // command doesn't block the receive loop.
      void this.handleRequest(req);
    });
  }

  stop(): void {
    this.detach?.();
    this.detach = null;
  }

  private async handleRequest(req: WsRpcRequest): Promise<void> {
    this.log('info', 'rpc:cal-request', {
      requestId: req.requestId, command: req.command, domain: req.parsed?.domain,
    });
    let result: { stdout: string; stderr: string; exitCode: number };
    try {
      result = await this.dispatch(req);
    } catch (err) {
      result = { stdout: '', stderr: `[handler] ${(err as Error).message}`, exitCode: 1 };
    }
    // Cap stdout to avoid blowing past WS frame limits.
    if (result.stdout.length > MAX_STDOUT_CHARS) {
      result.stdout = result.stdout.slice(0, MAX_STDOUT_CHARS) + `\n[stdout capped at ${MAX_STDOUT_CHARS} chars]`;
    }
    const response: WsRpcResponse = {
      type: 'rpc:cal-response',
      requestId: req.requestId,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
    try {
      await this.client.send(response);
    } catch (err) {
      this.log('error', 'failed to send rpc response', { err: (err as Error).message });
    }
  }

  private async dispatch(req: WsRpcRequest): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const domain = req.parsed?.domain;
    switch (domain) {
      case 'bash':
        return this.handleBash(req);
      case 'fs':
        return this.handleFs(req);
      // Capabilities we advertise but haven't implemented yet:
      case 'git':
      case 'docker':
      case 'k8s':
      case 'systemd':
      case 'pkg':
      case 'log':
      case 'net':
      case 'svc':
        return {
          stdout: '',
          stderr: `[mesh] domain '${domain}' not implemented on linux cli yet — falling back to bash via Cloud agent`,
          exitCode: 127,
        };
      default:
        return {
          stdout: '',
          stderr: `[mesh] unknown domain: ${domain}`,
          exitCode: 127,
        };
    }
  }

  /**
   * `bash exec --cmd="..."` or any other action where args.cmd is the
   * shell line. We deliberately only honour --cmd (not raw `command`)
   * to match the existing domain-RPC parser shape that other domains
   * use; if cmd is absent we fall back to req.command.
   */
  private handleBash(req: WsRpcRequest): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const shellLine = req.parsed?.args?.cmd ?? req.command ?? '';
    if (!shellLine.trim()) {
      return Promise.resolve({ stdout: '', stderr: '[bash] empty command', exitCode: 2 });
    }
    return new Promise((resolveP) => {
      const proc = spawn('sh', ['-c', shellLine], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      }, BASH_TIMEOUT_MS);
      proc.stdout.on('data', (b) => { stdout += b.toString('utf-8'); });
      proc.stderr.on('data', (b) => { stderr += b.toString('utf-8'); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (killed) {
          resolveP({ stdout, stderr: `[bash] timed out after ${BASH_TIMEOUT_MS / 1000}s`, exitCode: 124 });
        } else {
          resolveP({ stdout, stderr, exitCode: code ?? 1 });
        }
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        resolveP({ stdout: '', stderr: `[bash] spawn error: ${err.message}`, exitCode: 1 });
      });
    });
  }

  /**
   * `fs <action> --path=... --content=...` minimal port of the same
   * actions the macOS FileBridge exposes (Server/agent/commands/fsCommands.ts
   * lists the canonical action set). Stage A: cat / ls / mkdir / write.
   */
  private async handleFs(req: WsRpcRequest): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const action = req.parsed?.action ?? '';
    const args = req.parsed?.args ?? {};
    const path = typeof args.path === 'string' ? args.path : '';
    const safeJoinedPath = path && isAbsolute(path) ? path : resolvePath(process.cwd(), path);

    try {
      switch (action) {
        case 'cat':
        case 'read': {
          const content = await fsp.readFile(safeJoinedPath, 'utf-8');
          return { stdout: content, stderr: '', exitCode: 0 };
        }
        case 'ls': {
          const entries = await fsp.readdir(safeJoinedPath, { withFileTypes: true });
          const lines = entries.map((e) => `${e.isDirectory() ? 'd' : '-'} ${e.name}`);
          return { stdout: lines.join('\n'), stderr: '', exitCode: 0 };
        }
        case 'mkdir': {
          await fsp.mkdir(safeJoinedPath, { recursive: true });
          return { stdout: `created ${safeJoinedPath}`, stderr: '', exitCode: 0 };
        }
        case 'write': {
          const content = typeof args.content === 'string' ? args.content : '';
          await fsp.mkdir(join(safeJoinedPath, '..'), { recursive: true });
          await fsp.writeFile(safeJoinedPath, content, 'utf-8');
          return { stdout: `wrote ${content.length} bytes to ${safeJoinedPath}`, stderr: '', exitCode: 0 };
        }
        default:
          return { stdout: '', stderr: `[fs] unknown action: ${action}`, exitCode: 127 };
      }
    } catch (err) {
      return { stdout: '', stderr: `[fs] ${(err as Error).message}`, exitCode: 1 };
    }
  }

  private log(level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>): void {
    if (this.opts.log) { this.opts.log(level, msg, meta); return; }
    const line = meta ? `${msg} ${JSON.stringify(meta)}` : msg;
    if (level === 'error') console.error(`[rpc] ${line}`);
    else if (level === 'warn') console.warn(`[rpc] ${line}`);
    else console.log(`[rpc] ${line}`);
  }
}
