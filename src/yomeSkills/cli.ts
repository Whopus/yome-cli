// `yome skill <subcommand>` dispatcher. Returns the desired process exit code.

import { installFromLocal } from './install.js';
import { installFromGithub, isGithubSource } from './installGithub.js';
import { listInstalled } from './list.js';
import { uninstallBySlug } from './uninstall.js';
import { getYomeSkillsRoot } from './paths.js';
import { pingHubInstall } from './hubPing.js';
import { performLogin } from './login.js';
import { readAuthState, clearAuthState } from './auth.js';
import { setSkillEnabled, isSkillDisabled } from './enable.js';
import { updateSkills } from './update.js';
import { linkSkill, unlinkSkill } from './devLink.js';
import { publishSkill } from './publish.js';
import { searchHub } from './search.js';
import { readInstallMeta } from './installMeta.js';
import {
  KNOWN_CAPABILITIES, type Capability, normaliseDeclared, readAllowedCapabilities,
  grantCapability, revokeCapability, describeCapability,
} from './capabilities.js';
import { refreshIndex } from './skillsIndex.js';
import { readManifest } from './manifest.js';
import { installPathForSlug } from './paths.js';
import { validateSkillDir } from './validate.js';
import { runDoctor } from './doctor.js';
import { rollbackBySlug } from './rollback.js';

export interface SkillCliFlags {
  force?: boolean;
  verbose?: boolean;
  json?: boolean;
  /** --yes: bypass capability prompt during install. */
  yes?: boolean;
  /** --revoke <cap>: capability to revoke (yome skill perms). */
  revoke?: string;
  /** --grant <cap>: capability to grant (yome skill perms). */
  grant?: string;
  /** --skip-verify: bypass post-install sha256 check. Only for dev. */
  skipVerify?: boolean;
}

export async function runSkillSubcommand(args: string[], flags: SkillCliFlags): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case 'install':           return await doInstall(args.slice(1), flags);
    case 'uninstall':
    case 'rm':                return doUninstall(args.slice(1));
    case 'list':
    case 'ls':                return doList(flags);
    case 'enable':            return doEnable(args.slice(1), true);
    case 'disable':           return doEnable(args.slice(1), false);
    case 'update':            return doUpdate(args.slice(1), flags);
    case 'link':              return doLink(args.slice(1), flags);
    case 'unlink':            return doUnlink(args.slice(1));
    case 'search':            return await doSearch(args.slice(1), flags);
    case 'publish':           return await doPublish(args.slice(1), flags);
    case 'perms':             return doPerms(args.slice(1), flags);
    case 'validate':          return doValidate(args.slice(1), flags);
    case 'doctor':            return doDoctor(flags);
    case 'rollback':          return await doRollback(args.slice(1), flags);
    case undefined:
    case 'help':
    case '--help':            printSkillHelp(); return 0;
    default:
      console.error(`Unknown subcommand: yome skill ${sub}`);
      printSkillHelp();
      return 2;
  }
}

// `yome login / logout / whoami` are top-level (no `skill` prefix), so
// the entry point in cli/src/index.tsx routes them straight here.
//
// Identity model: these talk to Yome (yome_token), not GitHub directly.
// GitHub is one of the providers the user can log in *through*.

const HUB_BASE = (process.env.YOME_HUB_BASE || 'https://yome.work').replace(/\/+$/, '');

export async function runLogin(): Promise<number> {
  const result = await performLogin();
  if (!result.ok) {
    console.error(`✗ login failed: ${result.reason}`);
    if (result.code === 'yome_user_not_found') {
      console.error('   Hint: open https://yome.work, sign in once with the same GitHub account, then re-run `yome login`.');
    }
    return 1;
  }
  const provider = result.state!.provider_login ?? '(provider account)';
  console.log(`✓ logged in to Yome as ${provider} via ${result.state!.provider}`);
  console.log(`  yome user id: ${result.state!.yome_user_id}`);
  return 0;
}

export async function runLogout(): Promise<number> {
  const s = readAuthState();
  if (!s) { console.log('(was not logged in)'); return 0; }

  // Best-effort: tell the hub to revoke the token, then drop the local file.
  try {
    await fetch(`${HUB_BASE}/api/cli/auth/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.yome_token}` },
    });
  } catch { /* offline is fine — local clear still happens */ }
  clearAuthState();
  console.log('✓ logged out');
  return 0;
}

export async function runWhoami(): Promise<number> {
  const s = readAuthState();
  if (!s) { console.log('Not logged in. Run `yome login`.'); return 0; }

  // Try to fetch the live view from the hub. Fall back to the cached
  // ~/.yome/auth.json if the hub is unreachable so `whoami` still works
  // offline.
  try {
    const r = await fetch(`${HUB_BASE}/api/cli/auth/whoami`, {
      headers: { Authorization: `Bearer ${s.yome_token}` },
    });
    if (r.ok) {
      const j = (await r.json()) as { ok: boolean; user?: Record<string, unknown>; cli_token?: Record<string, unknown> };
      if (j.ok && j.user) {
        const u = j.user;
        const ct = j.cli_token ?? {};
        console.log(`Yome user: ${u.email ?? '(no email)'} (${u.user_id})`);
        if (u.github_username) console.log(`  github:       ${u.github_username}`);
        console.log(`  cli session:  ${ct.client_label ?? 'yome-cli'}, provider=${ct.provider}, last_used=${ct.last_used_at}`);
        console.log(`  expires at:   ${ct.expires_at}`);
        return 0;
      }
      if (r.status === 401) {
        console.error('✗ session is no longer valid — run `yome login`');
        return 1;
      }
    }
  } catch { /* fall through to cached */ }

  // Offline / hub unreachable
  console.log(`Yome user (cached): ${s.yome_user_id}`);
  console.log(`  provider:     ${s.provider} (${s.provider_login ?? '?'})`);
  console.log(`  obtained at:  ${s.obtained_at}`);
  console.log(`  expires at:   ${s.expires_at || '(unknown)'}`);
  console.log('  (hub unreachable — showing cached values)');
  return 0;
}

// ── skill subcommands ───────────────────────────────────────────────

async function doInstall(args: string[], flags: SkillCliFlags): Promise<number> {
  const source = args[0];
  if (!source) {
    console.error('Usage: yome skill install <source> [--force] [--verbose]');
    console.error('  <source> can be a local path, github:owner/repo[@ref][#subpath],');
    console.error('  or https://github.com/owner/repo[/tree/<ref>/<subpath>]');
    return 2;
  }
  const installOpts = {
    force: flags.force,
    verbose: flags.verbose,
    yes: flags.yes,
    skipVerify: flags.skipVerify,
  };
  const result = isGithubSource(source)
    ? await installFromGithub(source, installOpts)
    : await installFromLocal(source, installOpts);
  if (!result.ok) {
    console.error(`✗ install failed: ${result.reason}`);
    return 1;
  }
  console.log(`✓ installed ${result.slug} → ${result.installedAt} (${result.copiedFiles} files)`);
  if (result.slug) {
    try { await pingHubInstall(result.slug); } catch { /* unreachable */ }
  }
  return 0;
}

function doUninstall(args: string[]): number {
  const slug = args[0];
  if (!slug) { console.error('Usage: yome skill uninstall <@owner/name>'); return 2; }
  const result = uninstallBySlug(slug);
  if (!result.ok) { console.error(`✗ uninstall failed: ${result.reason}`); return 1; }
  console.log(`✓ removed ${result.slug} (was at ${result.removedFrom})`);
  return 0;
}

function doList(flags: SkillCliFlags): number {
  const items = listInstalled();
  // Enrich with status + source for the new STATUS / SOURCE columns.
  const rows = items.map((i) => {
    const meta = readInstallMeta(i.slug);
    const disabled = isSkillDisabled(i.slug);
    return {
      slug: i.slug,
      version: i.version,
      domain: i.domain,
      name: i.name ?? null,
      status: disabled ? 'disabled' : 'enabled',
      source: meta?.source ?? '(legacy)',
    };
  });

  if (flags.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return 0;
  }

  if (rows.length === 0) {
    console.log(`No skills installed under ${getYomeSkillsRoot()}.`);
    console.log('Try: yome skill install ./skills/yome-skill-ppt');
    return 0;
  }
  console.log(`Installed skills (${getYomeSkillsRoot()}):`);
  console.log('');
  const slugW   = Math.max(4, ...rows.map((r) => r.slug.length));
  const verW    = Math.max(7, ...rows.map((r) => r.version.length));
  const domainW = Math.max(6, ...rows.map((r) => r.domain.length));
  const statusW = Math.max(6, ...rows.map((r) => r.status.length));
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));

  console.log(`  ${pad('SLUG', slugW)}  ${pad('VERSION', verW)}  ${pad('DOMAIN', domainW)}  ${pad('STATUS', statusW)}  SOURCE`);
  for (const r of rows) {
    console.log(`  ${pad(r.slug, slugW)}  ${pad(r.version, verW)}  ${pad(r.domain, domainW)}  ${pad(r.status, statusW)}  ${r.source}`);
  }
  return 0;
}

function doEnable(args: string[], enabled: boolean): number {
  const slug = args[0];
  if (!slug) { console.error(`Usage: yome skill ${enabled ? 'enable' : 'disable'} <@owner/name>`); return 2; }
  const r = setSkillEnabled(slug, enabled);
  if (!r.ok) { console.error(`✗ ${enabled ? 'enable' : 'disable'} failed: ${r.reason}`); return 1; }
  console.log(`✓ ${r.slug} is now ${r.state}`);
  return 0;
}

async function doUpdate(args: string[], flags: SkillCliFlags): Promise<number> {
  const slug = args[0]; // optional
  const summary = await updateSkills(slug, { verbose: flags.verbose });
  if (summary.rows.length === 0) {
    console.log(slug ? `No installed skill named ${slug}.` : 'No skills installed.');
    return 0;
  }
  for (const r of summary.rows) {
    if (!r.ok) {
      console.error(`✗ ${r.slug}  ${r.reason}`);
      continue;
    }
    if (r.changed) {
      console.log(`↑ ${r.slug}  ${r.before} → ${r.after}`);
    } else {
      console.log(`= ${r.slug}  ${r.before}${r.reason ? `  (${r.reason})` : ''}`);
    }
  }
  return summary.allOk ? 0 : 1;
}

function doLink(args: string[], flags: SkillCliFlags): number {
  const path = args[0];
  if (!path) { console.error('Usage: yome skill link <path-to-skill> [--force]'); return 2; }
  const r = linkSkill(path, { force: flags.force });
  if (!r.ok) { console.error(`✗ link failed: ${r.reason}`); return 1; }
  console.log(`✓ linked ${r.slug} → ${r.installedAt} (target: ${r.linkedTo})`);
  return 0;
}

function doUnlink(args: string[]): number {
  const slug = args[0];
  if (!slug) { console.error('Usage: yome skill unlink <@owner/name>'); return 2; }
  const r = unlinkSkill(slug);
  if (!r.ok) { console.error(`✗ unlink failed: ${r.reason}`); return 1; }
  console.log(`✓ unlinked ${r.slug} (removed ${r.unlinkedAt})`);
  return 0;
}

async function doSearch(args: string[], flags: SkillCliFlags): Promise<number> {
  const query = args[0];
  if (!query) { console.error('Usage: yome skill search <query> [--json]'); return 2; }
  const r = await searchHub(query);
  if (!r.ok) { console.error(`✗ search failed: ${r.reason}`); return 1; }
  if (flags.json) {
    process.stdout.write(JSON.stringify(r.hits, null, 2) + '\n');
    return 0;
  }
  if (r.hits.length === 0) { console.log(`No skills match "${query}".`); return 0; }
  const slugW = Math.max(4, ...r.hits.map((h) => h.slug.length));
  const verW  = Math.max(7, ...r.hits.map((h) => (h.latest_version ?? '-').length));
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
  console.log(`  ${pad('SLUG', slugW)}  ${pad('VERSION', verW)}  ★    ↓    NAME`);
  for (const h of r.hits) {
    const stars = String(h.star_count ?? 0).padStart(4);
    const installs = String(h.install_count ?? 0).padStart(4);
    const flag = h.is_official ? ' [OFFICIAL]' : '';
    console.log(`  ${pad(h.slug, slugW)}  ${pad(h.latest_version ?? '-', verW)}  ${stars} ${installs}  ${h.name ?? ''}${flag}`);
  }
  return 0;
}

async function doPublish(_args: string[], flags: SkillCliFlags): Promise<number> {
  const r = await publishSkill(process.cwd(), { force: flags.force });
  if (!r.ok) { console.error(`✗ publish failed: ${r.reason}`); return 1; }
  console.log(`✓ published ${r.slug} v${r.version}`);
  return 0;
}

function doPerms(args: string[], flags: SkillCliFlags): number {
  const slug = args[0];
  if (!slug) {
    console.error('Usage: yome skill perms <@owner/name> [--grant=<cap>] [--revoke=<cap>]');
    console.error(`Capabilities: ${KNOWN_CAPABILITIES.join(', ')}`);
    return 2;
  }
  const dir = installPathForSlug(slug);
  if (!dir) { console.error(`malformed slug: ${slug}`); return 2; }
  const manifest = readManifest(dir);
  if (!manifest) { console.error(`✗ ${slug} is not installed`); return 1; }
  const declared = normaliseDeclared(manifest.system_capabilities);

  // Mutating action?
  const cap = (flags.grant ?? flags.revoke) as Capability | undefined;
  if (cap) {
    if (!(KNOWN_CAPABILITIES as readonly string[]).includes(cap)) {
      console.error(`unknown capability: ${cap} (allowed: ${KNOWN_CAPABILITIES.join(', ')})`);
      return 2;
    }
    if (flags.grant && !declared.includes(cap)) {
      console.error(`✗ cannot grant "${cap}" — not declared in manifest (declared: ${declared.join(', ') || '(none)'})`);
      return 1;
    }
    const changed = flags.grant ? grantCapability(slug, cap) : revokeCapability(slug, cap);
    if (changed) {
      try { refreshIndex(); } catch { /* best-effort */ }
      console.log(`✓ ${flags.grant ? 'granted' : 'revoked'} ${cap} on ${slug}`);
    } else {
      console.log(`(${cap} was already ${flags.grant ? 'granted' : 'not granted'})`);
    }
  }

  // Print current state.
  const ac = readAllowedCapabilities(slug);
  const allowed = ac?.allowed ?? [];
  if (flags.json) {
    process.stdout.write(JSON.stringify({ slug, declared, allowed, granted_at: ac?.granted_at, granted_by: ac?.granted_by }, null, 2) + '\n');
    return 0;
  }
  console.log(`Capabilities for ${slug}:`);
  if (declared.length === 0) {
    console.log('  (manifest declares no capabilities)');
  } else {
    for (const c of declared) {
      const mark = allowed.includes(c) ? '[x]' : '[ ]';
      console.log(`  ${mark} ${c.padEnd(12)} ${describeCapability(c)}`);
    }
  }
  if (ac) console.log(`  (granted ${ac.granted_at} by ${ac.granted_by})`);
  return 0;
}

function doValidate(args: string[], flags: SkillCliFlags): number {
  const target = args[0] ?? '.';
  const r = validateSkillDir(target);
  if (flags.json) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    return r.ok ? 0 : 1;
  }
  if (r.manifest) {
    console.log(`Validating ${r.manifest.slug} v${r.manifest.version} (domain=${r.manifest.domain})`);
  }
  for (const w of r.warnings) console.log(`  ! ${w}`);
  for (const e of r.errors)   console.log(`  ✗ ${e}`);
  if (r.ok) {
    console.log(`✓ ${r.manifest ? r.manifest.slug : target} passes validation` +
      (r.warnings.length ? ` (${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'})` : ''));
    return 0;
  }
  console.error(`✗ validation failed (${r.errors.length} error${r.errors.length === 1 ? '' : 's'})`);
  return 1;
}


function doDoctor(flags: SkillCliFlags): number {
  const r = runDoctor();
  if (flags.json) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    return r.ok ? 0 : 1;
  }
  console.log(`Scanned ${r.scanned} installed skill${r.scanned === 1 ? '' : 's'}.`);
  if (r.issues.length === 0) {
    console.log('✓ no issues found');
    return 0;
  }
  for (const it of r.issues) {
    const tag = it.level === 'error' ? '✗ ERROR  ' : '! warning';
    const where = it.slug ? ` ${it.slug}` : '';
    console.log(`  ${tag}${where}: ${it.message}`);
  }
  const errCount = r.issues.filter(i => i.level === 'error').length;
  return errCount === 0 ? 0 : 1;
}

async function doRollback(args: string[], flags: SkillCliFlags): Promise<number> {
  const slug = args[0];
  if (!slug) {
    console.error('Usage: yome skill rollback <slug>');
    return 2;
  }
  const r = await rollbackBySlug(slug);
  if (flags.json) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    return r.ok ? 0 : 1;
  }
  if (!r.ok) {
    console.error(`✗ rollback failed: ${r.reason ?? 'unknown error'}`);
    return 1;
  }
  const from = r.previousVersion ? ` from ${r.previousVersion}` : '';
  const to = r.restoredVersion ? ` to ${r.restoredVersion}` : '';
  console.log(`✓ rolled back ${r.slug ?? slug}${from}${to}`);
  return 0;
}

function printSkillHelp(): void {
  console.log(`
yome skill — manage installed yome-skill.json skills

Subcommands:
  install <source>    Install from local dir, github:owner/repo[@ref][#subpath],
                      or https://github.com/owner/repo[/tree/<ref>/<subpath>]
  uninstall <slug>    Remove an installed skill
  list                Show all installed skills (--json for machine-readable)
  enable  <slug>      Enable a previously-disabled skill
  disable <slug>      Disable a skill (agent loader will skip it)
  update [<slug>]     Re-pull installed skills from their original source
  link <path>         Symlink a working dir into the registry (dev mode)
  unlink <slug>       Remove a dev-link
  search <query>      Search the public hub (--json for machine-readable)
  publish             Publish the cwd skill to the hub (requires 'yome login')
  perms <slug>        View / change capability grants
                      e.g. yome skill perms @yome/ppt --revoke=fs:write
  validate [<path>]   Lint a skill directory (defaults to cwd)
  doctor              Sanity-check the local skill registry
  rollback <slug>     Swap back to the previous version (one level of undo)

Top-level commands (run as 'yome login', not 'yome skill login'):
  login               GitHub OAuth Device Flow
  logout              Forget the saved credentials
  whoami              Show currently logged-in user

Examples:
  yome skill install ./skills/yome-skill-ppt
  yome skill install github:Whopus/yome-skill-ppt
  yome skill list
  yome skill disable @yome/ppt
  yome skill update @yome/ppt
  yome skill link ./my-new-skill
  yome login
  yome skill publish
`);
}
