import type { Cell } from './cell.js';

export interface RenderableScreen {
  readonly rows: number;
  row(index: number): readonly Cell[];
}

/**
 * Render one row as plain text. The right half of a double-width character is stored
 * as `""`, so concatenation reproduces the row's display width exactly.
 */
export function serializeRow(cells: readonly Cell[]): string {
  let out = '';
  for (const cell of cells) out += cell.text;
  return out;
}

export function serializeRows(screen: RenderableScreen): string[] {
  const lines: string[] = [];
  for (let r = 0; r < screen.rows; r++) lines.push(serializeRow(screen.row(r)));
  return lines;
}

/**
 * Render the whole screen as newline-joined plain text rows.
 *
 * Deliberately free of cursor markers, row numbers and highlight encoding: agent-side
 * assertions and the `contains` wait conditions substring-match against this string,
 * so any in-band decoration would corrupt them. Cursor, size and mode travel as
 * separate structured fields.
 */
export function serializeScreen(screen: RenderableScreen): string {
  return serializeRows(screen).join('\n');
}
