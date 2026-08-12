import { describe, expect, it } from 'vitest';
import { serializeRow, serializeRows, serializeScreen } from '../../../src/screen/serializer.js';
import { ShadowScreen } from '../../../src/screen/shadow-screen.js';

describe('serializeRow', () => {
  it('concatenates cell text in column order', () => {
    expect(
      serializeRow([
        { text: 'h', hlId: 0 },
        { text: 'i', hlId: 1 },
      ]),
    ).toBe('hi');
  });

  it('emits nothing for the continuation cell of a wide character', () => {
    expect(
      serializeRow([
        { text: '한', hlId: 0 },
        { text: '', hlId: 0 },
      ]),
    ).toBe('한');
  });
});

describe('serializeScreen', () => {
  it('joins rows with newlines and preserves trailing whitespace', () => {
    const screen = new ShadowScreen(2, 4);
    screen.gridLine(0, 0, [{ text: 'a', hlId: 0 }]);
    expect(serializeScreen(screen)).toBe('a   \n    ');
  });

  it('preserves leading whitespace so columns stay aligned', () => {
    const screen = new ShadowScreen(1, 8);
    screen.gridLine(0, 4, [{ text: 'x', hlId: 0 }]);
    expect(serializeScreen(screen)).toBe('    x   ');
  });

  it('embeds no cursor marker, row number or highlight information', () => {
    const screen = new ShadowScreen(1, 5);
    screen.gridLine(0, 0, [{ text: 'q', hlId: 42 }]);
    screen.gridCursorGoto(0, 0);
    expect(serializeScreen(screen)).toBe('q    ');
  });

  it('supports clean substring matching, which is what the wait conditions need', () => {
    const screen = new ShadowScreen(3, 16);
    screen.gridLine(1, 2, [...'hello world'].map((ch) => ({ text: ch, hlId: 0 })));
    expect(serializeScreen(screen)).toContain('hello world');
  });

  it('is deterministic across repeated calls', () => {
    const screen = new ShadowScreen(4, 6);
    screen.gridLine(2, 1, [{ text: '·', hlId: 3, repeat: 4 }]);
    expect(serializeScreen(screen)).toBe(serializeScreen(screen));
  });

  it('reproduces display width for double-width characters', () => {
    const screen = new ShadowScreen(1, 6);
    screen.gridLine(0, 0, [
      { text: '漢', hlId: 0 },
      { text: '' },
      { text: '字', hlId: 0 },
      { text: '' },
    ]);
    expect(serializeScreen(screen)).toBe('漢字  ');
  });
});

describe('serializeRows', () => {
  it('returns one string per grid row', () => {
    const screen = new ShadowScreen(3, 2);
    expect(serializeRows(screen)).toEqual(['  ', '  ', '  ']);
  });
});
