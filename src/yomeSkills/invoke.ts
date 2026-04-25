// cli/src/yomeSkills/invoke.ts
//
// Top-level entry point for "execute an action on an installed hub
// skill". Handles slug/domain resolution, capability enforcement, and
// platform/backend selection. Both the `SkillCall` agent tool and the
// `yome <domain> <action>` CLI route through this.

import { homedir } from 'os';
import { getInstalledFast, type SkillIndexEntry } from './skillsIndex.js';
import { readManifest, type SkillManifest } from './manifest.js';
import { isCapabilityAllowed } from './capabilities.js';
import {
  dispatchMacos,
  type SkillCall as DispatchCall,
  type DispatchResult,
} from '../skills/runner/dispatcher.js';

/** Expand ~ in a path arg the same way a shell would. */
function expandTilde(v: string | boolean | number | undefined): string | boolean | number | undefined {
  if (typeof v !== 'string') return v;
  if (v === '~') return homedir();
  if (v.startsWith('~/')) return homedir() + v.slice(1);
  return v;
}

export interface InvokeRequest {
  /** Either '@owner/name' (preferred) or just a domain like 'ppt'. */
  slugOrDomain: string;
  /** Action name, e.g. 'new', 'slide.add'. */
  action: string;
  positionals?: string[];
  flags?: Record<string, string | boolean | number | undefined>;
}

export interface InvokeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Diagnostic — which skill we resolved to. */
  resolvedSlug?: string;
}

/**
 * Find the installed skill record for either `@owner/name` or `<domain>`.
 * Domain lookup picks the first installed skill that owns that domain;
 * if you have multiple, prefer the explicit slug.
 */
export function resolveSkill(slugOrDomain: string): SkillIndexEntry | null {
  const installed = getInstalledFast();
  if (slugOrDomain.startsWith('@')) {
    return installed.find((s) => s.slug === slugOrDomain) ?? null;
  }
  return installed.find((s) => s.domain === slugOrDomain) ?? null;
}

/**
 * Run an action. Honors capability grants — anything the manifest
 * declares as required (and that hasn't been allowed by the user) blocks
 * the call before we touch osascript.
 */
export async function invokeSkill(req: InvokeRequest): Promise<InvokeResult> {
  const entry = resolveSkill(req.slugOrDomain);
  if (!entry) {
    return {
      ok: false, stdout: '', stderr: `skill not installed: ${req.slugOrDomain}`,
      exitCode: 127,
    };
  }
  if (entry.status !== 'enabled') {
    return {
      ok: false, stdout: '', stderr: `skill ${entry.slug} is disabled — enable it via /skills`,
      exitCode: 1, resolvedSlug: entry.slug,
    };
  }

  const manifest = readManifest(entry.installedAt);
  if (!manifest) {
    return {
      ok: false, stdout: '', stderr: `failed to read manifest at ${entry.installedAt}`,
      exitCode: 1, resolvedSlug: entry.slug,
    };
  }

  // Enforce declared OS-level capabilities (security model).
  // Note: manifest.capabilities holds *semantic* labels (calendar:read);
  // system_capabilities holds the OS-level set we actually gate on.
  const declared = (manifest.system_capabilities ?? []) as Array<
    'fs:read' | 'fs:write' | 'fs:delete' | 'applescript' | 'network' | 'shell'
  >;
  const missing: string[] = [];
  for (const cap of declared) {
    if (!isCapabilityAllowed(entry.slug, cap)) missing.push(cap);
  }
  if (missing.length > 0) {
    return {
      ok: false, stdout: '',
      stderr:
        `capability not granted: ${missing.join(', ')}\n` +
        `Run: yome skill perms ${entry.slug} --grant ${missing[0]}`,
      exitCode: 13, resolvedSlug: entry.slug,
    };
  }

  // Pick the right backend for this host. We're CLI-on-macOS so the
  // delivery.macos slot is what we want; if the skill only ships a node
  // backend, dispatch to that instead (M1 — node backend not implemented
  // yet, returns an explanatory error).
  const platform = process.platform;
  if (platform !== 'darwin') {
    return {
      ok: false, stdout: '',
      stderr: `hub skill execution currently requires macOS (got ${platform})`,
      exitCode: 1, resolvedSlug: entry.slug,
    };
  }

  const r = await runMacos(entry, req);
  return { ...r, resolvedSlug: entry.slug };
}

async function runMacos(entry: SkillIndexEntry, req: InvokeRequest): Promise<DispatchResult> {
  // Expand ~ everywhere — AppleScript's `POSIX file "..."` doesn't honour
  // tilde, and forcing the LLM to spell out /Users/me/... is annoying.
  const positionals = (req.positionals ?? []).map((p) =>
    typeof p === 'string' ? (expandTilde(p) as string) : p,
  );
  const flags: Record<string, string | boolean | number | undefined> = {};
  for (const [k, v] of Object.entries(req.flags ?? {})) {
    flags[k] = expandTilde(v);
  }
  const call: DispatchCall = { positionals, flags };
  return dispatchMacos(entry.installedAt, req.action, call);
}
