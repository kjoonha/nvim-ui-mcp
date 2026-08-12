import { serializeRows } from './serializer.js';
import type { ShadowScreen, Cursor, ScreenMode } from './shadow-screen.js';

export interface ScreenSnapshot {
  rows: number;
  cols: number;
  lines: string[];
  cursor: Cursor;
  mode: ScreenMode;
}

export interface RowChange {
  row: number;
  before: string | null;
  after: string | null;
}

export interface ScreenDiff {
  changed: boolean;
  rowChanges: RowChange[];
  cursor?: { before: Cursor; after: Cursor };
  mode?: { before: ScreenMode; after: ScreenMode };
  size?: {
    before: { rows: number; cols: number };
    after: { rows: number; cols: number };
  };
}

export function captureSnapshot(screen: ShadowScreen): ScreenSnapshot {
  return {
    rows: screen.rows,
    cols: screen.cols,
    lines: serializeRows(screen),
    cursor: { ...screen.cursor },
    mode: { ...screen.mode },
  };
}

/** Compact, deterministic difference between two snapshots. */
export function diffSnapshots(before: ScreenSnapshot, after: ScreenSnapshot): ScreenDiff {
  const rowChanges: RowChange[] = [];
  const maxRows = Math.max(before.lines.length, after.lines.length);
  for (let r = 0; r < maxRows; r++) {
    const prev = before.lines[r] ?? null;
    const next = after.lines[r] ?? null;
    if (prev !== next) rowChanges.push({ row: r, before: prev, after: next });
  }

  const diff: ScreenDiff = { changed: rowChanges.length > 0, rowChanges };

  if (before.cursor.row !== after.cursor.row || before.cursor.col !== after.cursor.col) {
    diff.cursor = { before: before.cursor, after: after.cursor };
    diff.changed = true;
  }
  if (before.mode.name !== after.mode.name || before.mode.index !== after.mode.index) {
    diff.mode = { before: before.mode, after: after.mode };
    diff.changed = true;
  }
  if (before.rows !== after.rows || before.cols !== after.cols) {
    diff.size = {
      before: { rows: before.rows, cols: before.cols },
      after: { rows: after.rows, cols: after.cols },
    };
    diff.changed = true;
  }

  return diff;
}
