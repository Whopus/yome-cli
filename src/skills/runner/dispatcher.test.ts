import { describe, it, expect } from 'vitest';
import {
  parseColor,
  parseColorToAppleScriptRGB,
  renderTemplate,
  parsePartialOkFail,
  NAMED_COLORS,
} from './dispatcher.js';

describe('parseColor', () => {
  it('accepts hex with leading #', () => {
    const r = parseColor('#003366');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.literal).toBe('{0, 51, 102}');
      expect(r.rgb).toEqual([0, 51, 102]);
    }
  });

  it('accepts bare hex when shaped like 6-hex-chars', () => {
    const r = parseColor('003366');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.literal).toBe('{0, 51, 102}');
  });

  it('accepts R,G,B with channels 0..255', () => {
    const r = parseColor('0, 51, 102');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.literal).toBe('{0, 51, 102}');
  });

  it('rejects R,G,B with out-of-range channels and explains why', () => {
    const r = parseColor('300, 0, 0');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toMatch(/0\.\.255/);
  });

  it('accepts the named color "navy" (the case from the bug report)', () => {
    const r = parseColor('navy');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rgb).toEqual([0, 51, 102]);
  });

  it('accepts CSS named colors that were missing before (teal, royalblue, …)', () => {
    expect(parseColor('teal').ok).toBe(true);
    expect(parseColor('royalblue').ok).toBe(true);
    expect(parseColor('midnightblue').ok).toBe(true);
    expect(parseColor('lightgray').ok).toBe(true);
    expect(parseColor('darkorange').ok).toBe(true);
  });

  it('accepts CN aliases like 深蓝 / 海军蓝', () => {
    const a = parseColor('深蓝');
    const b = parseColor('海军蓝');
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.rgb).toEqual([0, 51, 102]);
      expect(b.rgb).toEqual([0, 51, 102]);
    }
  });

  it('rejects unknown names with a useful reason instead of failing silently', () => {
    const r = parseColor('rosegold');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.reason).toMatch(/unrecognised color/);
      expect(r.error.input).toBe('rosegold');
    }
  });

  it('rejects empty / whitespace-only input', () => {
    expect(parseColor('').ok).toBe(false);
    expect(parseColor('   ').ok).toBe(false);
  });

  it('does NOT silently treat a bare named color as accidental hex (e.g. "bed")', () => {
    expect(parseColor('bed').ok).toBe(false);
  });

  it('mirrors parseColorToAppleScriptRGB legacy contract', () => {
    expect(parseColorToAppleScriptRGB('navy')).toBe('{0, 51, 102}');
    expect(parseColorToAppleScriptRGB('not-a-color')).toBeNull();
  });

  it('NAMED_COLORS contains the keys the Swift bridges rely on', () => {
    for (const k of ['black', 'white', 'red', 'green', 'blue', 'navy', 'darkblue', 'yellow', 'orange', 'purple', 'pink', 'cyan', 'gray', 'grey']) {
      expect(NAMED_COLORS[k]).toBeDefined();
    }
  });
});

describe('renderTemplate', () => {
  it('substitutes simple {{name}} and filters', () => {
    const r = renderTemplate(
      'set x to {{a|json}}\nset n to {{n|as_int}}\nset y to {{b|bool}}',
      { a: 'hi "there"', n: '42', b: true },
    );
    expect(r.errors).toHaveLength(0);
    expect(r.source).toContain('set x to "hi \\"there\\""');
    expect(r.source).toContain('set n to 42');
    expect(r.source).toContain('set y to true');
  });

  it('strips {{#if}} blocks when the var is falsy', () => {
    const r = renderTemplate(
      'A\n{{#if bg}}set b to {{bg|rgb}}{{/if}}\nB',
      { bg: '' },
    );
    expect(r.errors).toHaveLength(0);
    // The whole conditional body is gone — including the bg|rgb filter
    // call — so an empty bg never reaches the rgb validator.
    expect(r.source).not.toContain('rgb');
    expect(r.source).not.toContain('missing value');
    expect(r.source.split('\n').filter(Boolean).join(' ')).toMatch(/^A\s*B$/);
  });

  it('emits a valid AppleScript literal for a recognised color', () => {
    const r = renderTemplate('set b to {{bg|rgb}}', { bg: 'navy' });
    expect(r.errors).toHaveLength(0);
    expect(r.source).toBe('set b to {0, 51, 102}');
  });

  it('records an error AND emits a syntactically valid placeholder for a bad color', () => {
    const r = renderTemplate('set b to {{bg|rgb}}', { bg: '深玫瑰红' });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.arg).toBe('bg');
    expect(r.errors[0]!.filter).toBe('rgb');
    expect(r.errors[0]!.reason).toMatch(/--bg=深玫瑰红/);
    // `missing value` is a real AppleScript token, so a downstream parse
    // doesn't blow up — but the dispatcher should still refuse to run it.
    expect(r.source).toBe('set b to missing value');
  });

  it('renders empty rgb input as an empty string literal (templates check `is not ""`)', () => {
    const r = renderTemplate('set rgbVal to {{color|rgb}}', { color: '' });
    expect(r.errors).toHaveLength(0);
    expect(r.source).toBe('set rgbVal to ""');
  });

  it('lets multiple bad |rgb args accumulate into one render report', () => {
    const r = renderTemplate(
      'set a to {{bg|rgb}}\nset b to {{color|rgb}}',
      { bg: 'fuchsia2', color: 'puce' },
    );
    expect(r.errors).toHaveLength(2);
    expect(r.errors.map((e) => e.arg).sort()).toEqual(['bg', 'color']);
  });
});

describe('parsePartialOkFail', () => {
  it('demuxes the okList|failList convention', () => {
    expect(parsePartialOkFail('bold,color,align|bg: missing color')).toEqual({
      ok: 'bold,color,align',
      fail: 'bg: missing color',
    });
  });

  it('treats a payload with no | as opaque', () => {
    expect(parsePartialOkFail('updated')).toBeNull();
  });

  it('handles "all-ok" (failList side empty)', () => {
    expect(parsePartialOkFail('bold,color|')).toEqual({ ok: 'bold,color', fail: '' });
  });

  it('handles "all-fail" (okList side empty)', () => {
    expect(parsePartialOkFail('|bg: missing color, color: missing color')).toEqual({
      ok: '',
      fail: 'bg: missing color, color: missing color',
    });
  });
});
