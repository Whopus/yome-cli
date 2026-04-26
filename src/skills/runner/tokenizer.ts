// cli/src/skills/runner/tokenizer.ts
//
// Shell-like tokenizer used by the yome agentic bash kernel.
//
// Lifted (with minor trimming) from Server/agent/commandParser.ts so the
// LLM-facing parsing in cli matches the macOS app behaviour byte-for-byte.
// Same quoting rules, same escape handling, same whitespace rules. We
// intentionally do NOT do shell expansion ($var, $(cmd), backticks, glob)
// — kernel commands are skill invocations, not real shell.

/**
 * Split a single command line into argv-ish tokens.
 *
 * Quoting: single + double quotes both supported, identical semantics
 * (no variable interpolation in either).
 * Escape: backslash. `\n` → newline, `\t` → tab, `\r` → CR, anything
 * else → the literal char (so `\\"` works). Escapes apply inside quotes
 * too, matching the Server tokenizer.
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuote: string | null = null;
  let escaped = false;
  let pushedAny = false; // tracks whether we've emitted a token for this segment

  const flush = () => {
    if (current.length > 0 || pushedAny) {
      tokens.push(current);
    }
    current = '';
    pushedAny = false;
  };

  for (const ch of input) {
    if (escaped) {
      if (ch === 'n') current += '\n';
      else if (ch === 't') current += '\t';
      else if (ch === 'r') current += '\r';
      else current += ch;
      escaped = false;
      pushedAny = true;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
        pushedAny = true; // even an empty "" should count as a token
      } else {
        current += ch;
        pushedAny = true;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      pushedAny = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0 || pushedAny) {
        tokens.push(current);
        current = '';
        pushedAny = false;
      }
      continue;
    }
    current += ch;
    pushedAny = true;
  }
  if (current.length > 0 || pushedAny) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Split a line on top-level (unquoted, unescaped) `&&` boundaries.
 *
 * Used by the kernel to support `xl X && xl Y && xl Z` — when EVERY
 * segment turns out to be a hub skill invocation, the kernel can run
 * them one by one with `&&` short-circuit semantics instead of dumping
 * the whole thing back to /bin/sh (which won't know about hub skills
 * and exits 127).
 *
 * Returns:
 *   - input as a single-element array if no top-level `&&` exists
 *   - the trimmed segments otherwise (empty segments dropped)
 *
 * Does NOT split on `;`, `||`, `|` — those keep going to shell so we
 * don't accidentally swallow real shell composition.
 */
export function splitOnUnquotedAmpAmp(input: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inQuote: string | null = null;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === '\\') { current += ch; escaped = true; continue; }
    if (inQuote) {
      current += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inQuote = ch; current += ch; continue; }
    if (ch === '&' && input[i + 1] === '&') {
      segments.push(current);
      current = '';
      i++; // skip the second '&'
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Detects whether the line contains shell control characters that mean
 * "this isn't a single skill invocation" (pipes, redirects, command
 * separators, subshells, heredoc). When true, the kernel should refuse
 * to handle the line and let it pass through to /bin/sh.
 *
 * Quoted control chars don't count.
 */
export function looksCompound(input: string): boolean {
  let inQuote: string | null = null;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inQuote = ch; continue; }
    // Control chars
    if (ch === '|' || ch === '&' || ch === ';' || ch === '<' || ch === '>') return true;
    if (ch === '`' || ch === '$' && input[i + 1] === '(') return true;
    if (ch === '\n') return true;
  }
  return false;
}
