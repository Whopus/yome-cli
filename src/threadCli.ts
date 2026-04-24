// cli/src/threadCli.ts — `yome thread <subcommand>` dispatcher.
//
// Subcommands:
//   yome thread list
//   yome thread share <session-id> --skill=<slug> [--out=<dir>] [--no-redact]
//                                   [--submit] [--case-id=<id>] [--dry-run]
//   yome thread submit <bundle-dir> --skill=<slug>
//                                   [--case-id=<id>] [--dry-run] [--verbose]

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildShareBundle } from './threadShare.js';
import { submitBundle } from './threadSubmit.js';
import { listSessions } from './sessions.js';

export interface ThreadCliFlags {
  skill?: string;
  out?: string;
  noRedact?: boolean;
  preview?: boolean;
  submit?: boolean;
  caseId?: string;
  dryRun?: boolean;
  verbose?: boolean;
}

export async function runThreadSubcommand(args: string[], flags: ThreadCliFlags): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case 'share':
      return doShare(args.slice(1), flags);
    case 'submit':
      return doSubmit(args.slice(1), flags);
    case 'list':
    case 'ls':
      return doList();
    case undefined:
    case 'help':
    case '--help':
      printThreadHelp();
      return 0;
    default:
      console.error(`Unknown subcommand: yome thread ${sub}`);
      printThreadHelp();
      return 2;
  }
}

function doShare(args: string[], flags: ThreadCliFlags): number {
  const sessionId = args[0];
  if (!sessionId) {
    console.error('Usage: yome thread share <session-id> --skill=<slug> [--out=<dir>] [--no-redact]');
    return 2;
  }
  if (!flags.skill) {
    console.error('--skill=<slug> is required (e.g. --skill=@yome/ppt)');
    return 2;
  }
  const outDir = flags.out
    ? resolve(flags.out)
    : join(homedir(), '.yome', 'shares', `${sessionId}-${Date.now()}`);

  const result = buildShareBundle({
    sessionId,
    skillSlug: flags.skill,
    outDir,
    rules: flags.noRedact ? [] : undefined,
  });
  if (!result.ok) {
    console.error(`✗ share failed: ${result.reason}`);
    return 1;
  }

  console.log(`✓ wrote bundle → ${result.outDir}`);
  console.log(`  messages: ${result.messageCount}   tool calls: ${result.toolCallCount}`);
  if (result.hits.length === 0) {
    console.log('  redaction: no hits');
  } else {
    console.log('  redaction:');
    for (const h of result.hits) {
      const samples = h.samples.length === 0 ? '' : `   e.g. ${h.samples.map(s => JSON.stringify(s)).join(', ')}`;
      console.log(`    ${h.rule.padEnd(20)} ×${h.count}${samples}`);
    }
  }
  console.log('');

  if (flags.submit) {
    console.log('Submitting bundle as a PR …');
    const submit = submitBundle({
      bundleDir: result.outDir,
      skillSlug: flags.skill,
      caseId: flags.caseId,
      dryRun: !!flags.dryRun,
      verbose: !!flags.verbose,
    });
    if (!submit.ok) {
      console.error(`✗ submit failed: ${submit.reason}`);
      if (submit.cloneDir) console.error(`  clone left at: ${submit.cloneDir}`);
      return 1;
    }
    if (submit.prUrl) {
      console.log(`✓ PR opened: ${submit.prUrl}`);
    } else {
      console.log(`✓ dry-run prepared in: ${submit.cloneDir}`);
      console.log(`  branch: ${submit.branch} (not pushed)`);
    }
    return 0;
  }

  console.log('Next: review files in the bundle, fill in fixtures.json,');
  console.log(`then run: yome thread submit ${result.outDir} --skill=${flags.skill}`);
  return 0;
}

function doSubmit(args: string[], flags: ThreadCliFlags): number {
  const bundleDir = args[0];
  if (!bundleDir) {
    console.error('Usage: yome thread submit <bundle-dir> --skill=<slug> [--case-id=<id>] [--dry-run] [--verbose]');
    return 2;
  }
  if (!flags.skill) {
    console.error('--skill=<slug> is required (e.g. --skill=@yome/ppt)');
    return 2;
  }
  const result = submitBundle({
    bundleDir: resolve(bundleDir),
    skillSlug: flags.skill,
    caseId: flags.caseId,
    dryRun: !!flags.dryRun,
    verbose: !!flags.verbose,
  });
  if (!result.ok) {
    console.error(`✗ submit failed: ${result.reason}`);
    if (result.cloneDir) console.error(`  clone left at: ${result.cloneDir}`);
    return 1;
  }
  if (result.prUrl) {
    console.log(`✓ PR opened: ${result.prUrl}`);
  } else {
    console.log(`✓ dry-run prepared in: ${result.cloneDir}`);
    console.log(`  branch: ${result.branch} (not pushed)`);
  }
  console.log(`  upstream: ${result.upstream}`);
  console.log(`  case-id : ${result.caseId}`);
  return 0;
}

function doList(): number {
  const items = listSessions();
  if (items.length === 0) {
    console.log('No sessions found for this cwd.');
    return 0;
  }
  const idW = Math.max(8, ...items.map(i => i.sessionId.length));
  const titleW = Math.max(5, ...items.map(i => Math.min(60, i.title.length)));
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
  const trunc = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s;

  console.log(`  ${pad('SESSION', idW)}  ${pad('TITLE', titleW)}  MSGS  MODIFIED`);
  for (const i of items) {
    console.log(`  ${pad(i.sessionId, idW)}  ${pad(trunc(i.title, titleW), titleW)}  ${String(i.messageCount).padStart(4)}  ${i.lastModified.toISOString().slice(0, 19)}`);
  }
  return 0;
}

function printThreadHelp(): void {
  console.log(`
yome thread — manage and share agent threads

Subcommands:
  share <session-id> --skill=<slug>    Build a redacted case bundle from a session
                  [--out=<dir>]        (default: ~/.yome/shares/<id>-<ts>/)
                  [--no-redact]        Disable the default redactor (NOT recommended)
                  [--submit]           Open a PR to the skill repo right after share
                  [--case-id=<id>]     Override the cases/<domain>/<id>/ name
                  [--dry-run]          (with --submit) prepare the commit but don't push
                  [--verbose]          Print every git/gh shell command

  submit <bundle-dir> --skill=<slug>   Push an existing bundle as a PR
                  [--case-id=<id>] [--dry-run] [--verbose]

  list                                 List sessions in the current cwd

Examples:
  yome thread list
  yome thread share 7c1f2e... --skill=@yome/ppt
  yome thread share 7c1f2e... --skill=@yome/ppt --submit
  yome thread submit ~/.yome/shares/7c1f2e-1745... --skill=@yome/ppt --dry-run

Requires gh CLI authenticated (gh auth login). The token-less hub-bot relay
path is planned for Phase 3 and not yet implemented.
`);
}
