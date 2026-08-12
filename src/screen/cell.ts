/** One screen cell. `text` is `""` for the right half of a double-width character. */
export interface Cell {
  text: string;
  hlId: number;
}

export function blankCell(): Cell {
  return { text: ' ', hlId: 0 };
}

export function cloneCell(cell: Cell): Cell {
  return { text: cell.text, hlId: cell.hlId };
}
