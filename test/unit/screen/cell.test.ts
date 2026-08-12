import { describe, expect, it } from 'vitest';
import { blankCell, cloneCell, type Cell } from '../../../src/screen/cell.js';
import { ShadowScreen } from '../../../src/screen/shadow-screen.js';

describe('blankCell', () => {
  it('is a space with highlight 0', () => {
    expect(blankCell()).toEqual({ text: ' ', hlId: 0 });
  });

  it('returns a fresh object each call so grid cells never alias', () => {
    const a = blankCell();
    const b = blankCell();
    a.text = 'x';
    expect(b.text).toBe(' ');
  });
});

describe('cloneCell', () => {
  it('copies by value', () => {
    const source: Cell = { text: '가', hlId: 4 };
    const copy = cloneCell(source);
    expect(copy).toEqual(source);
    copy.hlId = 9;
    expect(source.hlId).toBe(4);
  });
});

describe('cell independence in the grid', () => {
  it('does not alias cells written by a repeat run', () => {
    const screen = new ShadowScreen(1, 3);
    screen.gridLine(0, 0, [{ text: 'x', hlId: 1, repeat: 3 }]);
    screen.gridLine(0, 1, [{ text: 'y', hlId: 2 }]);
    expect(screen.row(0).map((c) => c.text)).toEqual(['x', 'y', 'x']);
  });

  it('does not alias rows produced by a scroll', () => {
    const screen = new ShadowScreen(2, 2);
    screen.gridLine(0, 0, [{ text: 'a', hlId: 0, repeat: 2 }]);
    screen.gridScroll(0, 2, 0, 2, -1);
    screen.gridLine(0, 0, [{ text: 'z', hlId: 0 }]);
    expect(screen.cell(1, 0).text).toBe('a');
  });
});
