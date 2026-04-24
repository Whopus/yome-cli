// cli/src/redact.ts — Yome ThreadRedactor (spec 9, CLI side).
//
// Local-side redaction of an agent thread before it is shared as a "case"
// to a skill's GitHub repo. Runs entirely on-device — the hub's optional
// re-check is a backstop, never a replacement.
//
// Pipeline:
//   text → applyRules(text, rules)  →  { redacted, ruleHits }
//   structured value → redactValue (deep walk) → redacted clone
//
// Default rules (per spec 9.2): email | phone | api-key | mind | path.
// `mind` only applies to structured payloads (it drops fields whose key is
// `mind` or that look like a mind block). `path` rewrites `/Users/<name>/`
// to `/Users/{user}/`. The rest are pure regex substitutions on text.
//
// Determinism: same input + same rule set → same output. No randomness.

export type RedactionRule =
  | { kind: 'pii'; pattern: 'email' | 'phone' | 'name' | 'id' }
  | { kind: 'path' }
  | { kind: 'mind' }
  | { kind: 'api-key' }
  | { kind: 'custom'; id: string; find: RegExp | string; replaceWith: string };

export interface RuleHit {
  /** Stable identifier for grouping/UI: `pii:email`, `api-key`, `custom:my-rule`, ... */
  rule: string;
  count: number;
  /** Up to MAX_SAMPLES short examples of the original (pre-redaction) text. */
  samples: string[];
}

export interface RedactionResult {
  redacted: string;
  hits: RuleHit[];
}

export interface RedactionPreview {
  before: string;
  after: string;
  ruleHits: RuleHit[];
}

const MAX_SAMPLES = 3;
const SAMPLE_MAX_LEN = 80;

/** Default rule set per spec 9.2. */
export const DEFAULT_RULES: RedactionRule[] = [
  { kind: 'pii', pattern: 'email' },
  { kind: 'pii', pattern: 'phone' },
  { kind: 'api-key' },
  { kind: 'path' },
  { kind: 'mind' },
];

// ── Built-in patterns ───────────────────────────────────────────────────────

/** RFC 5322-lite — covers the realistic 99%, not pathological corner cases. */
const EMAIL_RE = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/**
 * Phone: international (+CC...) and CN mobile (1[3-9]\d{9}).
 * NB: avoid eating arbitrary 10-digit numbers; require + or 1[3-9] anchor.
 */
const PHONE_RE = /(\+\d{1,3}[ -]?\d{1,4}([ -]?\d{2,4}){2,4}|\b1[3-9]\d{9}\b)/g;

/**
 * API keys we know the prefix for. Anchored to whole "word" to avoid eating
 * random hex blobs. Add new patterns here as we discover them in the wild.
 */
const API_KEY_RES: { id: string; re: RegExp }[] = [
  // Anthropic must come BEFORE openai because `sk-ant-...` would otherwise
  // be eaten by the openai pattern (`sk-` + alphanum).
  { id: 'anthropic',  re: /\bsk-ant-(?:api03-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: 'openai',     re: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: 'github',     re: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { id: 'aws',        re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'google',     re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'slack',      re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'jwt',        re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { id: 'generic-bearer', re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g },
];

/** Match `/Users/<username>/...` (macOS) and `/home/<username>/...` (Linux). */
const PATH_RE = /(\/Users|\/home)\/([^/\s"'<>]+)/g;

// ── Helpers ─────────────────────────────────────────────────────────────────

function pushHit(hits: Map<string, RuleHit>, ruleId: string, sample: string): void {
  let hit = hits.get(ruleId);
  if (!hit) {
    hit = { rule: ruleId, count: 0, samples: [] };
    hits.set(ruleId, hit);
  }
  hit.count++;
  if (hit.samples.length < MAX_SAMPLES) {
    const trimmed = sample.length > SAMPLE_MAX_LEN ? sample.slice(0, SAMPLE_MAX_LEN) + '…' : sample;
    if (!hit.samples.includes(trimmed)) hit.samples.push(trimmed);
  }
}

function applyRegex(
  text: string,
  re: RegExp,
  ruleId: string,
  hits: Map<string, RuleHit>,
  replacer: (match: string, ...groups: string[]) => string,
): string {
  // RegExp must be /g — clone if a caller passed one without the flag.
  const safeRe = re.flags.includes('g') ? re : new RegExp(re.source, re.flags + 'g');
  return text.replace(safeRe, (match: string, ...args: unknown[]) => {
    pushHit(hits, ruleId, match);
    // groups are everything but the last two args (offset, full string)
    const groups = args.slice(0, -2) as string[];
    return replacer(match, ...groups);
  });
}

// ── Text-level rule application ─────────────────────────────────────────────

/**
 * Apply text-redacting rules to a string. `mind` rule is a no-op here (it
 * only matters for structured value walks); everything else operates on text.
 */
export function redactText(text: string, rules: RedactionRule[] = DEFAULT_RULES): RedactionResult {
  const hits = new Map<string, RuleHit>();
  let out = text;

  for (const rule of rules) {
    if (rule.kind === 'pii') {
      switch (rule.pattern) {
        case 'email':
          out = applyRegex(out, EMAIL_RE, 'pii:email', hits,
            (_m, local, domain) => `${(local || '').slice(0, 1)}***@${domain}`);
          break;
        case 'phone':
          out = applyRegex(out, PHONE_RE, 'pii:phone', hits, () => '[REDACTED_PHONE]');
          break;
        case 'name':
          // Name detection without a model is high-FP; for v0.1 this is an
          // opt-in that does nothing unless paired with a custom rule.
          break;
        case 'id':
          // Reserved for future use (national ID, SSN). v0.1 no-op.
          break;
      }
    } else if (rule.kind === 'api-key') {
      for (const { id, re } of API_KEY_RES) {
        out = applyRegex(out, re, `api-key:${id}`, hits, () => `[REDACTED_${id.toUpperCase()}_KEY]`);
      }
    } else if (rule.kind === 'path') {
      out = applyRegex(out, PATH_RE, 'path', hits, (_m, root) => `${root}/{user}`);
    } else if (rule.kind === 'custom') {
      const re = typeof rule.find === 'string'
        ? new RegExp(rule.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
        : rule.find;
      out = applyRegex(out, re, `custom:${rule.id}`, hits, () => rule.replaceWith);
    }
    // `mind` is value-walk-only (see redactValue)
  }

  return { redacted: out, hits: Array.from(hits.values()) };
}

// ── Structured value walk (for thread.json / trace.json) ────────────────────

const MIND_KEY_RE = /^(mind|user_?mind|private_?mind)$/i;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function mergeHits(into: Map<string, RuleHit>, from: RuleHit[]): void {
  for (const h of from) {
    const existing = into.get(h.rule);
    if (!existing) {
      into.set(h.rule, { rule: h.rule, count: h.count, samples: [...h.samples] });
    } else {
      existing.count += h.count;
      for (const s of h.samples) {
        if (existing.samples.length >= MAX_SAMPLES) break;
        if (!existing.samples.includes(s)) existing.samples.push(s);
      }
    }
  }
}

interface ValueRedactionResult {
  redacted: unknown;
  hits: RuleHit[];
}

/**
 * Deep-walk a JSON-like value, redacting strings via `redactText` and
 * dropping `mind` fields when the `mind` rule is enabled. Arrays/objects
 * are cloned; primitives are returned by value.
 */
export function redactValue(value: unknown, rules: RedactionRule[] = DEFAULT_RULES): ValueRedactionResult {
  const dropMind = rules.some(r => r.kind === 'mind');
  const allHits = new Map<string, RuleHit>();

  function walk(v: unknown): unknown {
    if (typeof v === 'string') {
      const r = redactText(v, rules);
      mergeHits(allHits, r.hits);
      return r.redacted;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v)) {
        if (dropMind && MIND_KEY_RE.test(k)) {
          pushHit(allHits, 'mind', `<dropped field "${k}">`);
          continue;
        }
        out[k] = walk(child);
      }
      return out;
    }
    return v;
  }

  const redacted = walk(value);
  return { redacted, hits: Array.from(allHits.values()) };
}

// ── Diff preview helper ─────────────────────────────────────────────────────

/**
 * Build a redaction preview for one chunk of text. Returns the original,
 * the redacted output, and the per-rule hit summary suitable for a diff UI.
 */
export function buildPreview(text: string, rules: RedactionRule[] = DEFAULT_RULES): RedactionPreview {
  const { redacted, hits } = redactText(text, rules);
  return { before: text, after: redacted, ruleHits: hits };
}

/** Sum hits across an array of RuleHit groups (e.g. per-message hits). */
export function totalHits(perMessage: RuleHit[][]): RuleHit[] {
  const merged = new Map<string, RuleHit>();
  for (const group of perMessage) mergeHits(merged, group);
  return Array.from(merged.values()).sort((a, b) => b.count - a.count);
}
