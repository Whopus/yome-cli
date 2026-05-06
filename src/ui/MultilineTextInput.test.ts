import { describe, expect, it } from 'vitest';
import {
  buildInputLayout,
  getCursorPosition,
  moveCursorVertically,
} from './MultilineTextInput.js';

describe('MultilineTextInput layout', () => {
  it('preserves explicit newlines as separate visual lines', () => {
    const layout = buildInputLayout('one\ntwo\nthree', 20);

    expect(layout.lines.map((line) => line.text)).toEqual(['one', 'two', 'three']);
    expect(getCursorPosition(layout, 0)).toEqual({ lineIndex: 0, column: 0 });
    expect(getCursorPosition(layout, 3)).toEqual({ lineIndex: 0, column: 3 });
    expect(getCursorPosition(layout, 4)).toEqual({ lineIndex: 1, column: 0 });
    expect(getCursorPosition(layout, 7)).toEqual({ lineIndex: 1, column: 3 });
  });

  it('moves vertically across logical lines while preserving the target column', () => {
    const value = 'abc\nde\nwxyz';

    expect(moveCursorVertically(value, 2, 20, 'down')).toBe(6);
    expect(moveCursorVertically(value, 6, 20, 'down')).toBe(9);
    expect(moveCursorVertically(value, 9, 20, 'up')).toBe(6);
  });

  it('moves vertically across wrapped visual lines', () => {
    const value = 'abcdef';
    const layout = buildInputLayout(value, 3);

    expect(layout.lines.map((line) => line.text)).toEqual(['abc', 'def']);
    expect(getCursorPosition(layout, 3)).toEqual({ lineIndex: 1, column: 0 });
    expect(moveCursorVertically(value, 1, 3, 'down')).toBe(4);
  });

  it('uses display width when wrapping CJK text', () => {
    const layout = buildInputLayout('你好a', 4);

    expect(layout.lines.map((line) => line.text)).toEqual(['你好', 'a']);
  });
});
