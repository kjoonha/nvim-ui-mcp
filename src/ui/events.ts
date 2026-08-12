/**
 * Typed representation of the `redraw` UI events this server handles.
 *
 * A `redraw` notification payload is an array of *events*; each event is
 * `[name, ...argSets]` where every argSet is one invocation of that event.
 * See `:help ui-linegrid`.
 */

/** The composited global grid. `ext_multigrid` is never enabled, so no other grid id occurs. */
export const GLOBAL_GRID = 1;

/** `[text]`, `[text, hlId]`, or `[text, hlId, repeat]`. */
export interface GridLineCell {
  text: string;
  hlId?: number;
  repeat?: number;
}

export interface HlAttrs {
  rgb: Record<string, unknown>;
  cterm: Record<string, unknown>;
  info: unknown[];
}

export type UiEvent =
  | { kind: 'grid_resize'; grid: number; width: number; height: number }
  | { kind: 'grid_line'; grid: number; row: number; colStart: number; cells: GridLineCell[] }
  | { kind: 'grid_clear'; grid: number }
  | {
      kind: 'grid_scroll';
      grid: number;
      top: number;
      bot: number;
      left: number;
      right: number;
      rows: number;
      cols: number;
    }
  | { kind: 'grid_cursor_goto'; grid: number; row: number; col: number }
  | { kind: 'hl_attr_define'; id: number; attrs: HlAttrs }
  | { kind: 'default_colors_set'; fg: number; bg: number; sp: number }
  | { kind: 'mode_change'; name: string; index: number }
  | { kind: 'flush' };

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseCells(value: unknown): GridLineCell[] | null {
  if (!Array.isArray(value)) return null;
  const cells: GridLineCell[] = [];
  for (const raw of value) {
    if (!Array.isArray(raw) || typeof raw[0] !== 'string') return null;
    const cell: GridLineCell = { text: raw[0] };
    const hlId = num(raw[1]);
    if (hlId !== null) cell.hlId = hlId;
    const repeat = num(raw[2]);
    if (repeat !== null) cell.repeat = repeat;
    cells.push(cell);
  }
  return cells;
}

/**
 * Parse one event invocation. Returns `null` when the event is not handled or its
 * arguments are malformed — a session must never die because Neovim added an event.
 */
export function parseUiEvent(name: string, args: readonly unknown[]): UiEvent | null {
  switch (name) {
    case 'grid_resize': {
      const [grid, width, height] = [num(args[0]), num(args[1]), num(args[2])];
      if (grid === null || width === null || height === null) return null;
      return { kind: 'grid_resize', grid, width, height };
    }
    case 'grid_line': {
      const [grid, row, colStart] = [num(args[0]), num(args[1]), num(args[2])];
      const cells = parseCells(args[3]);
      if (grid === null || row === null || colStart === null || cells === null) return null;
      return { kind: 'grid_line', grid, row, colStart, cells };
    }
    case 'grid_clear': {
      const grid = num(args[0]);
      if (grid === null) return null;
      return { kind: 'grid_clear', grid };
    }
    case 'grid_scroll': {
      const [grid, top, bot, left, right, rows, cols] = [0, 1, 2, 3, 4, 5, 6].map((i) =>
        num(args[i]),
      );
      if (
        grid == null ||
        top == null ||
        bot == null ||
        left == null ||
        right == null ||
        rows == null ||
        cols == null
      ) {
        return null;
      }
      return { kind: 'grid_scroll', grid, top, bot, left, right, rows, cols };
    }
    case 'grid_cursor_goto': {
      const [grid, row, col] = [num(args[0]), num(args[1]), num(args[2])];
      if (grid === null || row === null || col === null) return null;
      return { kind: 'grid_cursor_goto', grid, row, col };
    }
    case 'hl_attr_define': {
      const id = num(args[0]);
      if (id === null) return null;
      return {
        kind: 'hl_attr_define',
        id,
        attrs: {
          rgb: record(args[1]),
          cterm: record(args[2]),
          info: Array.isArray(args[3]) ? args[3] : [],
        },
      };
    }
    case 'default_colors_set': {
      const [fg, bg, sp] = [num(args[0]), num(args[1]), num(args[2])];
      if (fg === null || bg === null || sp === null) return null;
      return { kind: 'default_colors_set', fg, bg, sp };
    }
    case 'mode_change': {
      const modeName = args[0];
      const index = num(args[1]);
      if (typeof modeName !== 'string' || index === null) return null;
      return { kind: 'mode_change', name: modeName, index };
    }
    case 'flush':
      return { kind: 'flush' };
    default:
      return null;
  }
}
