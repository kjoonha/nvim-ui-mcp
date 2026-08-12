import { describe, expect, it } from 'vitest';
import { captureSnapshot, diffSnapshots } from '../../../src/screen/diff.js';
import { ShadowScreen } from '../../../src/screen/shadow-screen.js';

const write = (screen: ShadowScreen, row: number, col: number, value: string): void => {
  screen.gridLine(
    row,
    col,
    [...value].map((ch) => ({ text: ch, hlId: 0 })),
  );
};

describe('captureSnapshot', () => {
  it('captures rows, size, cursor and mode', () => {
    const screen = new ShadowScreen(2, 3);
    write(screen, 0, 0, 'abc');
    screen.gridCursorGoto(1, 2);
    screen.modeChange('insert', 3);

    expect(captureSnapshot(screen)).toEqual({
      rows: 2,
      cols: 3,
      lines: ['abc', '   '],
      cursor: { row: 1, col: 2 },
      mode: { name: 'insert', index: 3 },
    });
  });

  it('is detached from later screen mutations', () => {
    const screen = new ShadowScreen(1, 3);
    const snapshot = captureSnapshot(screen);
    write(screen, 0, 0, 'xyz');
    screen.gridCursorGoto(0, 2);
    expect(snapshot.lines).toEqual(['   ']);
    expect(snapshot.cursor).toEqual({ row: 0, col: 0 });
  });
});

describe('diffSnapshots', () => {
  it('reports no change for identical snapshots', () => {
    const screen = new ShadowScreen(2, 3);
    const diff = diffSnapshots(captureSnapshot(screen), captureSnapshot(screen));
    expect(diff).toEqual({ changed: false, rowChanges: [] });
  });

  it('reports only the rows that changed', () => {
    const screen = new ShadowScreen(3, 3);
    const before = captureSnapshot(screen);
    write(screen, 1, 0, 'abc');
    const diff = diffSnapshots(before, captureSnapshot(screen));

    expect(diff.changed).toBe(true);
    expect(diff.rowChanges).toEqual([{ row: 1, before: '   ', after: 'abc' }]);
  });

  it('reports multiple changed rows in ascending order', () => {
    const screen = new ShadowScreen(4, 2);
    const before = captureSnapshot(screen);
    write(screen, 3, 0, 'zz');
    write(screen, 0, 0, 'aa');
    const diff = diffSnapshots(before, captureSnapshot(screen));
    expect(diff.rowChanges.map((c) => c.row)).toEqual([0, 3]);
  });

  it('reports a cursor move with no row change', () => {
    const screen = new ShadowScreen(2, 2);
    const before = captureSnapshot(screen);
    screen.gridCursorGoto(1, 1);
    const diff = diffSnapshots(before, captureSnapshot(screen));

    expect(diff.changed).toBe(true);
    expect(diff.rowChanges).toEqual([]);
    expect(diff.cursor).toEqual({ before: { row: 0, col: 0 }, after: { row: 1, col: 1 } });
  });

  it('reports a mode change', () => {
    const screen = new ShadowScreen(1, 1);
    const before = captureSnapshot(screen);
    screen.modeChange('insert', 3);
    const diff = diffSnapshots(before, captureSnapshot(screen));
    expect(diff.mode).toEqual({
      before: { name: 'normal', index: 0 },
      after: { name: 'insert', index: 3 },
    });
  });

  it('reports a resize, with null for rows that did not exist before', () => {
    const screen = new ShadowScreen(1, 2);
    const before = captureSnapshot(screen);
    screen.gridResize(2, 3);
    const diff = diffSnapshots(before, captureSnapshot(screen));

    expect(diff.size).toEqual({ before: { rows: 1, cols: 2 }, after: { rows: 3, cols: 2 } });
    expect(diff.rowChanges).toEqual([
      { row: 1, before: null, after: '  ' },
      { row: 2, before: null, after: '  ' },
    ]);
  });

  it('reports null for rows removed by a shrink', () => {
    const screen = new ShadowScreen(3, 2);
    const before = captureSnapshot(screen);
    screen.gridResize(2, 1);
    const diff = diffSnapshots(before, captureSnapshot(screen));
    expect(diff.rowChanges).toEqual([
      { row: 1, before: '  ', after: null },
      { row: 2, before: '  ', after: null },
    ]);
  });

  it('is deterministic for the same pair of snapshots', () => {
    const screen = new ShadowScreen(2, 4);
    const before = captureSnapshot(screen);
    write(screen, 0, 1, 'hi');
    const after = captureSnapshot(screen);
    expect(diffSnapshots(before, after)).toEqual(diffSnapshots(before, after));
  });
});
