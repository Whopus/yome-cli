// `yome skill update [<slug>]` — re-pull installed skills and replace.
//
// We rely on `.install-meta.json` to know how each skill was installed.
// For each candidate skill:
//   - source starts with "github:"  → re-run installFromGithub with --force
//   - source starts with "local:"   → re-run installFromLocal  with --force
//   - source starts with "dev-link" → no-op (the symlink already lives)
//   - source missing                → "no install metadata; please reinstall"
//
// We compare manifest_version before/after and only print the row if it
// actually changed (or always if --verbose).

import { installFromLocal } from './install.js';
import { installFromGithub } from './installGithub.js';
import { listInstalled } from './list.js';
import { readInstallMeta } from './installMeta.js';
import { readManifest } from './manifest.js';

export interface UpdateOptions {
  verbose?: boolean;
}

export interface UpdateRow {
  slug: string;
  source: string | null;
  before: string;
  after: string | null;
  changed: boolean;
  ok: boolean;
  reason?: string;
}

export interface UpdateSummary {
  rows: UpdateRow[];
  /** True if every attempted update succeeded (skipped rows count as ok). */
  allOk: boolean;
}

export async function updateSkills(filterSlug: string | undefined, opts: UpdateOptions = {}): Promise<UpdateSummary> {
  const installed = listInstalled();
  const target = filterSlug
    ? installed.filter((i) => i.slug === filterSlug)
    : installed;
  const rows: UpdateRow[] = [];
  let allOk = true;

  for (const sk of target) {
    const meta = readInstallMeta(sk.slug);
    const before = sk.version;

    if (!meta) {
      rows.push({ slug: sk.slug, source: null, before, after: null, changed: false, ok: false,
        reason: 'no .install-meta.json (was installed before metadata existed); reinstall manually to enable updates',
      });
      allOk = false;
      continue;
    }

    if (meta.source.startsWith('dev-link:')) {
      rows.push({ slug: sk.slug, source: meta.source, before, after: before, changed: false, ok: true,
        reason: 'dev-link (live)',
      });
      continue;
    }

    let result;
    if (meta.source.startsWith('github:')) {
      result = await installFromGithub(meta.source, { force: true, verbose: opts.verbose, yes: true });
    } else if (meta.source.startsWith('local:')) {
      const path = meta.source.slice('local:'.length);
      result = await installFromLocal(path, { force: true, verbose: opts.verbose, yes: true });
    } else {
      rows.push({ slug: sk.slug, source: meta.source, before, after: null, changed: false, ok: false,
        reason: `unsupported source type: ${meta.source}`,
      });
      allOk = false;
      continue;
    }

    if (!result.ok) {
      rows.push({ slug: sk.slug, source: meta.source, before, after: null, changed: false, ok: false,
        reason: result.reason,
      });
      allOk = false;
      continue;
    }
    const reread = readManifest(result.installedAt!);
    const after = reread?.version ?? before;
    rows.push({
      slug: sk.slug,
      source: meta.source,
      before,
      after,
      changed: after !== before,
      ok: true,
    });
  }

  return { rows, allOk };
}
