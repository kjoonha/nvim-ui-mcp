import { describe, expect, it } from 'vitest';
import { ShadowScreen } from '../../../src/screen/shadow-screen.js';
import { serializeRow } from '../../../src/screen/serializer.js';

const text = (screen: ShadowScreen, row: number): string => serializeRow(screen.row(row));

describe('initial grid creation', () => {
  it('defaults to 24x80 filled with blanks and highlight 0', () => {
    const screen = new ShadowScreen();
    expect(screen.rows).toBe(24);
    expect(screen.cols).toBe(80);
    expect(screen.cell(0, 0)).toEqual({ text: ' ', hlId: 0 });
    expect(text(screen, 23)).toBe(' '.repeat(80));
  });

  it('accepts an explicit size', () => {
    const screen = new ShadowScreen(3, 5);
    expect(screen.rows).toBe(3);
    expect(screen.cols).toBe(5);
    expect(text(screen, 2)).toBe('     ');
  });

  it('starts inconsistent, with no flushes and no dirty rows', () => {
    const screen = new ShadowScreen(2, 2);
    expect(screen.consistent).toBe(false);
    expect(screen.flushCount).toBe(0);
    expect([...screen.dirtyRows]).toEqual([]);
  });

  it('throws for out-of-range access', () => {
    const screen = new ShadowScreen(2, 2);
    expect(() => screen.row(2)).toThrow(RangeError);
    expect(() => screen.cell(0, 5)).toThrow(RangeError);
  });
});

describe('gridLine', () => {
  it('writes individual cells from colStart', () => {
    const screen = new ShadowScreen(1, 10);
    screen.gridLine(0, 2, [{ text: 'a', hlId: 1 }, { text: 'b' }, { text: 'c' }]);
    expect(text(screen, 0)).toBe('  abc     ');
  });

  it('reuses the last hlId when a cell omits it', () => {
    const screen = new ShadowScreen(1, 4);
    screen.gridLine(0, 0, [
      { text: 'a', hlId: 7 },
      { text: 'b' },
      { text: 'c', hlId: 9 },
      { text: 'd' },
    ]);
    expect(screen.row(0).map((c) => c.hlId)).toEqual([7, 7, 9, 9]);
  });

  it('resets hlId tracking between separate gridLine calls', () => {
    const screen = new ShadowScreen(1, 2);
    screen.gridLine(0, 0, [{ text: 'a', hlId: 5 }]);
    screen.gridLine(0, 1, [{ text: 'b' }]);
    expect(screen.cell(0, 1).hlId).toBe(0);
  });

  it('expands repeat counts', () => {
    const screen = new ShadowScreen(1, 10);
    screen.gridLine(0, 0, [
      { text: '-', hlId: 3, repeat: 4 },
      { text: 'x', hlId: 4 },
      { text: '=', hlId: 5, repeat: 5 },
    ]);
    expect(text(screen, 0)).toBe('----x=====');
    expect(screen.row(0).map((c) => c.hlId)).toEqual([3, 3, 3, 3, 4, 5, 5, 5, 5, 5]);
  });

  it('clips writes that would overflow the row', () => {
    const screen = new ShadowScreen(1, 5);
    screen.gridLine(0, 3, [{ text: 'z', hlId: 0, repeat: 20 }]);
    expect(text(screen, 0)).toBe('   zz');
  });

  it('ignores writes to rows outside the grid', () => {
    const screen = new ShadowScreen(1, 3);
    expect(() => screen.gridLine(9, 0, [{ text: 'x', hlId: 0 }])).not.toThrow();
    expect(text(screen, 0)).toBe('   ');
  });

  it('marks only the written row dirty', () => {
    const screen = new ShadowScreen(3, 3);
    screen.flush();
    screen.gridLine(1, 0, [{ text: 'x', hlId: 0 }]);
    expect([...screen.dirtyRows]).toEqual([1]);
  });
});

describe('gridLine Unicode and double-width', () => {
  it('stores the empty continuation cell of a double-width character verbatim', () => {
    const screen = new ShadowScreen(1, 6);
    screen.gridLine(0, 0, [
      { text: '한', hlId: 0 },
      { text: '' },
      { text: '글', hlId: 0 },
      { text: '' },
    ]);
    expect(screen.row(0).map((c) => c.text)).toEqual(['한', '', '글', '', ' ', ' ']);
    expect(text(screen, 0)).toBe('한글  ');
  });

  it('keeps column arithmetic correct after wide characters', () => {
    const screen = new ShadowScreen(1, 8);
    screen.gridLine(0, 0, [{ text: '漢', hlId: 0 }, { text: '' }, { text: 'a', hlId: 0 }]);
    expect(screen.cell(0, 2).text).toBe('a');
  });

  it('handles emoji as double-width cells', () => {
    const screen = new ShadowScreen(1, 4);
    screen.gridLine(0, 0, [{ text: '🚀', hlId: 0 }, { text: '' }, { text: '!', hlId: 0 }]);
    expect(text(screen, 0)).toBe('🚀! ');
    expect(screen.cell(0, 1).text).toBe('');
  });

  it('preserves combining characters as a single cell', () => {
    const screen = new ShadowScreen(1, 3);
    screen.gridLine(0, 0, [{ text: 'é', hlId: 0 }, { text: 'x' }]);
    expect(screen.cell(0, 0).text).toBe('é');
    expect(text(screen, 0)).toBe('éx ');
  });

  it('applies repeat to non-ASCII text', () => {
    const screen = new ShadowScreen(1, 6);
    screen.gridLine(0, 0, [{ text: '─', hlId: 2, repeat: 6 }]);
    expect(text(screen, 0)).toBe('──────');
  });
});

describe('gridClear', () => {
  it('resets every cell to a blank with highlight 0', () => {
    const screen = new ShadowScreen(2, 4);
    screen.gridLine(0, 0, [{ text: 'x', hlId: 5, repeat: 4 }]);
    screen.gridLine(1, 0, [{ text: 'y', hlId: 5, repeat: 4 }]);
    screen.gridClear();
    expect(text(screen, 0)).toBe('    ');
    expect(text(screen, 1)).toBe('    ');
    expect(screen.row(0).every((c) => c.hlId === 0)).toBe(true);
  });

  it('marks every row dirty', () => {
    const screen = new ShadowScreen(3, 2);
    screen.flush();
    screen.gridClear();
    expect([...screen.dirtyRows].sort()).toEqual([0, 1, 2]);
  });
});

describe('gridResize', () => {
  const fill = (screen: ShadowScreen, lines: string[]): void => {
    lines.forEach((line, row) => {
      screen.gridLine(
        row,
        0,
        [...line].map((ch) => ({ text: ch, hlId: 1 })),
      );
    });
  };

  it('grows, preserving existing content and blank-filling the new area', () => {
    const screen = new ShadowScreen(2, 3);
    fill(screen, ['abc', 'def']);
    screen.gridResize(5, 4);
    expect(screen.rows).toBe(4);
    expect(screen.cols).toBe(5);
    expect(text(screen, 0)).toBe('abc  ');
    expect(text(screen, 1)).toBe('def  ');
    expect(text(screen, 3)).toBe('     ');
  });

  it('shrinks, dropping the trimmed region', () => {
    const screen = new ShadowScreen(3, 5);
    fill(screen, ['abcde', 'fghij', 'klmno']);
    screen.gridResize(3, 2);
    expect(screen.rows).toBe(2);
    expect(screen.cols).toBe(3);
    expect(text(screen, 0)).toBe('abc');
    expect(text(screen, 1)).toBe('fgh');
    expect(() => screen.row(2)).toThrow(RangeError);
  });

  it('preserves highlight ids of surviving cells', () => {
    const screen = new ShadowScreen(1, 3);
    screen.gridLine(0, 0, [{ text: 'a', hlId: 12 }]);
    screen.gridResize(6, 2);
    expect(screen.cell(0, 0)).toEqual({ text: 'a', hlId: 12 });
  });

  it('clamps the cursor into the new bounds and drops stale dirty rows', () => {
    const screen = new ShadowScreen(10, 10);
    screen.gridCursorGoto(9, 9);
    screen.gridResize(4, 3);
    expect(screen.cursor).toEqual({ row: 2, col: 3 });
    expect([...screen.dirtyRows].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });
});

describe('gridScroll', () => {
  const build = (lines: string[]): ShadowScreen => {
    const screen = new ShadowScreen(lines.length, lines[0]?.length ?? 0);
    lines.forEach((line, row) => {
      screen.gridLine(
        row,
        0,
        [...line].map((ch) => ({ text: ch, hlId: 0 })),
      );
    });
    screen.flush();
    return screen;
  };

  it('scrolls up by one, leaving the vacated row untouched', () => {
    const screen = build(['aaa', 'bbb', 'ccc', 'ddd']);
    screen.gridScroll(0, 4, 0, 3, 1);
    expect([0, 1, 2, 3].map((r) => text(screen, r))).toEqual(['bbb', 'ccc', 'ddd', 'ddd']);
  });

  it('scrolls up by more than one row', () => {
    const screen = build(['aaa', 'bbb', 'ccc', 'ddd']);
    screen.gridScroll(0, 4, 0, 3, 2);
    expect([0, 1].map((r) => text(screen, r))).toEqual(['ccc', 'ddd']);
  });

  it('scrolls down by one', () => {
    const screen = build(['aaa', 'bbb', 'ccc', 'ddd']);
    screen.gridScroll(0, 4, 0, 3, -1);
    expect([0, 1, 2, 3].map((r) => text(screen, r))).toEqual(['aaa', 'aaa', 'bbb', 'ccc']);
  });

  it('respects a partial row region', () => {
    const screen = build(['aaa', 'bbb', 'ccc', 'ddd']);
    screen.gridScroll(1, 3, 0, 3, 1);
    expect([0, 1, 2, 3].map((r) => text(screen, r))).toEqual(['aaa', 'ccc', 'ccc', 'ddd']);
  });

  it('respects a partial column region', () => {
    const screen = build(['abcd', 'efgh', 'ijkl']);
    screen.gridScroll(0, 3, 1, 3, 1);
    expect([0, 1, 2].map((r) => text(screen, r))).toEqual(['afgd', 'ejkh', 'ijkl']);
  });

  it('is a no-op when rows is 0', () => {
    const screen = build(['aaa', 'bbb']);
    screen.gridScroll(0, 2, 0, 3, 0);
    expect([0, 1].map((r) => text(screen, r))).toEqual(['aaa', 'bbb']);
  });

  it('tolerates a scroll larger than the region', () => {
    const screen = build(['aaa', 'bbb']);
    expect(() => screen.gridScroll(0, 2, 0, 3, 5)).not.toThrow();
    expect([0, 1].map((r) => text(screen, r))).toEqual(['aaa', 'bbb']);
  });

  it('marks the whole scrolled region dirty', () => {
    const screen = build(['aaa', 'bbb', 'ccc', 'ddd']);
    screen.gridScroll(1, 3, 0, 3, 1);
    expect([...screen.dirtyRows].sort((a, b) => a - b)).toEqual([1, 2]);
  });
});

describe('cursor, highlights, colors and mode', () => {
  it('moves the cursor', () => {
    const screen = new ShadowScreen(10, 10);
    screen.gridCursorGoto(4, 7);
    expect(screen.cursor).toEqual({ row: 4, col: 7 });
  });

  it('records highlight definitions', () => {
    const screen = new ShadowScreen(1, 1);
    screen.hlAttrDefine(3, { rgb: { foreground: 255 }, cterm: { bold: true }, info: [] });
    expect(screen.highlights.get(3)).toEqual({
      rgb: { foreground: 255 },
      cterm: { bold: true },
      info: [],
    });
  });

  it('overwrites a redefined highlight id', () => {
    const screen = new ShadowScreen(1, 1);
    screen.hlAttrDefine(3, { rgb: { foreground: 1 }, cterm: {}, info: [] });
    screen.hlAttrDefine(3, { rgb: { foreground: 2 }, cterm: {}, info: [] });
    expect(screen.highlights.get(3)?.rgb).toEqual({ foreground: 2 });
  });

  it('records default colors', () => {
    const screen = new ShadowScreen(1, 1);
    screen.defaultColorsSet(0xffffff, 0x000000, 0xff0000);
    expect(screen.defaultColors).toEqual({ fg: 0xffffff, bg: 0x000000, sp: 0xff0000 });
  });

  it('records mode changes', () => {
    const screen = new ShadowScreen(1, 1);
    expect(screen.mode).toEqual({ name: 'normal', index: 0 });
    screen.modeChange('insert', 3);
    expect(screen.mode).toEqual({ name: 'insert', index: 3 });
  });
});

describe('flush consistency gate', () => {
  it('is inconsistent until the first flush', () => {
    const screen = new ShadowScreen(1, 1);
    expect(screen.consistent).toBe(false);
    screen.flush();
    expect(screen.consistent).toBe(true);
    expect(screen.flushCount).toBe(1);
  });

  it.each([
    ['gridLine', (s: ShadowScreen) => s.gridLine(0, 0, [{ text: 'x', hlId: 0 }])],
    ['gridClear', (s: ShadowScreen) => s.gridClear()],
    ['gridResize', (s: ShadowScreen) => s.gridResize(2, 2)],
    ['gridScroll', (s: ShadowScreen) => s.gridScroll(0, 1, 0, 1, 1)],
    ['gridCursorGoto', (s: ShadowScreen) => s.gridCursorGoto(0, 0)],
    ['hlAttrDefine', (s: ShadowScreen) => s.hlAttrDefine(1, { rgb: {}, cterm: {}, info: [] })],
    ['defaultColorsSet', (s: ShadowScreen) => s.defaultColorsSet(1, 2, 3)],
    ['modeChange', (s: ShadowScreen) => s.modeChange('insert', 1)],
  ])('%s clears consistency until the next flush', (_name, mutate) => {
    const screen = new ShadowScreen(4, 4);
    screen.flush();
    expect(screen.consistent).toBe(true);
    mutate(screen);
    expect(screen.consistent).toBe(false);
    screen.flush();
    expect(screen.consistent).toBe(true);
  });
});

describe('dirty row tracking', () => {
  it('accumulates across a frame and survives until the next frame starts', () => {
    const screen = new ShadowScreen(5, 5);
    screen.gridLine(0, 0, [{ text: 'a', hlId: 0 }]);
    screen.gridLine(3, 0, [{ text: 'b', hlId: 0 }]);
    screen.flush();
    expect([...screen.dirtyRows].sort((a, b) => a - b)).toEqual([0, 3]);

    screen.gridLine(2, 0, [{ text: 'c', hlId: 0 }]);
    expect([...screen.dirtyRows]).toEqual([2]);
  });

  it('does not mark rows dirty for cursor or mode events', () => {
    const screen = new ShadowScreen(5, 5);
    screen.flush();
    screen.gridCursorGoto(2, 2);
    screen.modeChange('insert', 1);
    expect([...screen.dirtyRows]).toEqual([]);
  });
});
