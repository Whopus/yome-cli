// cli/src/skills/runner/nodeBackend.ts
//
// Generic OTA Node backend dispatcher for hub skills.
//
// Skill layout:
//   ~/.yome/skills/@owner/foo/
//     yome-skill.json           (manifest with delivery.node.entry pointer)
//     backends/node/
//       package.json            (private; declares { type: "module" })
//       src/index.{js,ts,mjs}   (default export OR named `dispatch` function)
//
// Contract: the entry module must export
//
//   export async function dispatch(req: NodeBackendRequest): Promise<NodeBackendResult>
//
// Where:
//
//   NodeBackendRequest  = { action, positionals, flags }
//   NodeBackendResult   = { ok, stdout?, stderr?, exitCode? }
//
// We do NOT spawn a child process for each call (cold-start latency
// would kill the LLM loop). Instead we dynamic-`import()` the entry
// once per skill+version and cache the module.
//
// This means the skill author can keep state across calls (e.g. a
// shared playwright browser handle). They MUST clean up on SIGTERM
// themselves if they care; the CLI process owning the cache exits
// when the user does.

import { existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readManifest, type SkillManifest } from '../../yomeSkills/manifest.js';

export interface NodeBackendRequest {
  action: string;
  positionals: string[];
  flags: Record<string, string | boolean | number | undefined>;
}

export interface NodeBackendResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export interface DispatchResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface BackendModule {
  dispatch: (req: NodeBackendRequest) => Promise<NodeBackendResult>;
}

// Cache by absolute entry path so two skills sharing a node_modules tree
// (rare but possible with --link dev installs) still get one cached
// module each.
const moduleCache = new Map<string, BackendModule>();

/** True when the skill ships a node OTA backend the CLI can load. */
export function hasNodeBackend(skillDir: string): boolean {
  return resolveNodeEntry(skillDir) !== null;
}

/**
 * Look up the node entry from the manifest's `delivery.node` block. We
 * accept both the spec'd shape (`{ package, entry }`) and a few common
 * variations to keep skill authors happy.
 */
function resolveNodeEntry(skillDir: string): string | null {
  const manifest = readManifest(skillDir);
  if (!manifest) return null;
  const delivery = (manifest.delivery ?? {}) as Record<string, unknown>;
  const node = delivery.node as undefined | {
    backend?: string;
    package?: string;
    entry?: string;
  };
  if (!node) return null;
  if (node.backend && node.backend !== 'ota') return null;

  // Default layout: backends/node/src/index.ts (or .js / .mjs after build).
  const pkg = typeof node.package === 'string' ? node.package : 'backends/node';
  const entry = typeof node.entry === 'string' ? node.entry : 'src/index.ts';

  // Try the manifest-declared entry first, then walk a list of common
  // built-output paths so the same yome-skill.json can serve src .ts
  // (dev) and dist .js (published) without two copies of the manifest.
  const baseAbs = isAbsolute(pkg) ? pkg : join(skillDir, pkg);
  const candidates = [
    join(baseAbs, entry),
    // src/ → dist/ swap, .ts → .js
    join(baseAbs, entry.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js')),
    join(baseAbs, entry.replace(/\.ts$/, '.js')),
    join(baseAbs, entry.replace(/\.ts$/, '.mjs')),
    join(baseAbs, 'dist/index.js'),
    join(baseAbs, 'src/index.js'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

async function loadBackend(skillDir: string): Promise<BackendModule | null> {
  const entry = resolveNodeEntry(skillDir);
  if (!entry) return null;
  const cached = moduleCache.get(entry);
  if (cached) return cached;
  let mod: any;
  try {
    mod = await import(pathToFileURL(entry).href);
  } catch (e) {
    process.stderr.write(`[nodeBackend] failed to load ${entry}: ${(e as Error).message}\n`);
    return null;
  }
  // Accept either { dispatch } or default export with .dispatch.
  const dispatch =
    (typeof mod?.dispatch === 'function' && mod.dispatch) ||
    (typeof mod?.default?.dispatch === 'function' && mod.default.dispatch) ||
    null;
  if (!dispatch) {
    process.stderr.write(`[nodeBackend] ${entry} does not export 'dispatch'\n`);
    return null;
  }
  const backend: BackendModule = { dispatch };
  moduleCache.set(entry, backend);
  return backend;
}

/**
 * Run an action via the skill's node backend. Returns a normalised
 * DispatchResult shape that mirrors dispatcher.ts so invoke.ts can
 * treat both backends uniformly.
 */
export async function dispatchNode(
  skillDir: string,
  action: string,
  call: { positionals: string[]; flags: Record<string, string | boolean | number | undefined> },
): Promise<DispatchResult> {
  const backend = await loadBackend(skillDir);
  if (!backend) {
    return {
      ok: false, stdout: '',
      stderr: 'no node backend installed for this skill (or load failed; check stderr)',
      exitCode: 2,
    };
  }
  let r: NodeBackendResult;
  try {
    r = await backend.dispatch({ action, positionals: call.positionals, flags: call.flags });
  } catch (e) {
    return {
      ok: false, stdout: '',
      stderr: `node backend threw: ${(e as Error).message}`,
      exitCode: 1,
    };
  }
  return {
    ok: !!r.ok,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    exitCode: r.exitCode ?? (r.ok ? 0 : 1),
  };
}

/** For tests / hot-reload: drop a cached backend so the next call re-imports. */
export function invalidateBackendCache(skillDir?: string): void {
  if (!skillDir) { moduleCache.clear(); return; }
  const entry = resolveNodeEntry(skillDir);
  if (entry) moduleCache.delete(entry);
}

// Re-export for convenience.
export type { SkillManifest };
