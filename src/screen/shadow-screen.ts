import { blankCell, cloneCell, type Cell } from './cell.js';
import type { GridLineCell, HlAttrs } from '../ui/events.js';

export interface Cursor {
  row: number;
  col: number;
}

export interface ScreenMode {
  name: string;
  index: number;
}

export interface DefaultColors {
  fg: number;
  bg: number;
  sp: number;
}

export const DEFAULT_ROWS = 24;
export const DEFAULT_COLS = 80;

/**
 * In-memory reconstruction of the grid Neovim would have painted to a terminal,
 * modelled on Neovim's own `test/functional/ui/screen.lua`.
 */
export class ShadowScreen {
  #grid: Cell[][] = [];
  #rows = 0;
  #cols = 0;
  #cursor: Cursor = { row: 0, col: 0 };
  #mode: ScreenMode = { name: 'normal', index: 0 };
  #highlights = new Map<number, HlAttrs>();
  #defaultColors: DefaultColors = { fg: -1, bg: -1, sp: -1 };
  #consistent = false;
  #flushCount = 0;
  #dirtyRows = new Set<number>();
  #frameClosed = false;

  constructor(rows: number = DEFAULT_ROWS, cols: number = DEFAULT_COLS) {
    this.#allocate(rows, cols);
  }

  get rows(): number {
    return this.#rows;
  }

  get cols(): number {
    return this.#cols;
  }

  get cursor(): Readonly<Cursor> {
    return this.#cursor;
  }

  get mode(): Readonly<ScreenMode> {
    return this.#mode;
  }

  get highlights(): ReadonlyMap<number, HlAttrs> {
    return this.#highlights;
  }

  get defaultColors(): Readonly<DefaultColors> {
    return this.#defaultColors;
  }

  /** False while a frame is partially applied; true only between `flush` and the next mutation. */
  get consistent(): boolean {
    return this.#consistent;
  }

  get flushCount(): number {
    return this.#flushCount;
  }

  /** Rows mutated during the most recent frame. Reserved for future event-driven diffing. */
  get dirtyRows(): ReadonlySet<number> {
    return this.#dirtyRows;
  }

  row(index: number): readonly Cell[] {
    const row = this.#grid[index];
    if (!row) throw new RangeError(`row ${index} out of range (0..${this.#rows - 1})`);
    return row;
  }

  cell(row: number, col: number): Cell {
    const cell = this.#grid[row]?.[col];
    if (!cell) throw new RangeError(`cell (${row}, ${col}) out of range`);
    return cell;
  }

  gridResize(width: number, height: number): void {
    this.#beginMutation();
    const previous = this.#grid;
    this.#allocate(height, width);
    for (let r = 0; r < height; r++) {
      const oldRow = previous[r];
      const newRow = this.#grid[r];
      if (!oldRow || !newRow) continue;
      for (let c = 0; c < width && c < oldRow.length; c++) {
        const old = oldRow[c];
        if (old) newRow[c] = cloneCell(old);
      }
    }
    this.#cursor = {
      row: Math.min(this.#cursor.row, Math.max(0, height - 1)),
      col: Math.min(this.#cursor.col, Math.max(0, width - 1)),
    };
    for (const dirty of [...this.#dirtyRows]) {
      if (dirty >= height) this.#dirtyRows.delete(dirty);
    }
    for (let r = 0; r < height; r++) this.#dirtyRows.add(r);
  }

  gridLine(row: number, colStart: number, cells: readonly GridLineCell[]): void {
    this.#beginMutation();
    const target = this.#grid[row];
    if (!target) return;
    let col = colStart;
    let hlId = 0;
    for (const cell of cells) {
      if (cell.hlId !== undefined) hlId = cell.hlId;
      const repeat = cell.repeat ?? 1;
      for (let i = 0; i < repeat && col < this.#cols; i++, col++) {
        target[col] = { text: cell.text, hlId };
      }
    }
    this.#dirtyRows.add(row);
  }

  gridClear(): void {
    this.#beginMutation();
    for (let r = 0; r < this.#rows; r++) {
      const row = this.#grid[r];
      if (!row) continue;
      for (let c = 0; c < this.#cols; c++) row[c] = blankCell();
      this.#dirtyRows.add(r);
    }
  }

  /**
   * Move the region `[top, bot) x [left, right)` vertically by `rows`.
   * Positive scrolls up (content moves toward `top`), negative scrolls down.
   * Vacated cells are left untouched — Neovim sends `grid_line` for them.
   */
  gridScroll(top: number, bot: number, left: number, right: number, rows: number): void {
    this.#beginMutation();
    if (rows === 0) return;

    const copyRow = (dst: number, src: number): void => {
      const dstRow = this.#grid[dst];
      const srcRow = this.#grid[src];
      if (!dstRow || !srcRow) return;
      for (let c = left; c < right && c < this.#cols; c++) {
        const cell = srcRow[c];
        if (cell) dstRow[c] = cloneCell(cell);
      }
    };

    if (rows > 0) {
      for (let i = top; i <= bot - rows - 1; i++) copyRow(i, i + rows);
    } else {
      for (let i = bot - 1; i >= top - rows; i--) copyRow(i, i + rows);
    }
    for (let r = top; r < bot; r++) this.#dirtyRows.add(r);
  }

  gridCursorGoto(row: number, col: number): void {
    this.#beginMutation();
    this.#cursor = { row, col };
  }

  hlAttrDefine(id: number, attrs: HlAttrs): void {
    this.#beginMutation();
    this.#highlights.set(id, attrs);
  }

  defaultColorsSet(fg: number, bg: number, sp: number): void {
    this.#beginMutation();
    this.#defaultColors = { fg, bg, sp };
  }

  modeChange(name: string, index: number): void {
    this.#beginMutation();
    this.#mode = { name, index };
  }

  flush(): void {
    this.#consistent = true;
    this.#frameClosed = true;
    this.#flushCount++;
  }

  #allocate(rows: number, cols: number): void {
    const grid: Cell[][] = [];
    for (let r = 0; r < rows; r++) {
      const row: Cell[] = new Array<Cell>(cols);
      for (let c = 0; c < cols; c++) row[c] = blankCell();
      grid[r] = row;
    }
    this.#grid = grid;
    this.#rows = rows;
    this.#cols = cols;
  }

  #beginMutation(): void {
    if (this.#frameClosed) {
      this.#dirtyRows.clear();
      this.#frameClosed = false;
    }
    this.#consistent = false;
  }
}
