import type { ShadowScreen } from '../screen/shadow-screen.js';
import { GLOBAL_GRID, parseUiEvent, type UiEvent } from './events.js';

/**
 * Turns raw `redraw` notification payloads into `ShadowScreen` mutations.
 *
 * Pure with respect to transport: it consumes plain arrays and knows nothing about
 * the RPC client, which is what makes it unit-testable without a Neovim process.
 */
export class UiEventProcessor {
  readonly screen: ShadowScreen;
  #unhandled = new Map<string, number>();
  #malformed = 0;

  constructor(screen: ShadowScreen) {
    this.screen = screen;
  }

  /** Event names seen but not handled, with occurrence counts. */
  get unhandledEvents(): ReadonlyMap<string, number> {
    return this.#unhandled;
  }

  get malformedEventCount(): number {
    return this.#malformed;
  }

  /**
   * Apply one `redraw` batch. The payload is an array of `[name, ...argSets]` events,
   * where each argSet is a separate invocation of the same event.
   */
  handleRedraw(batch: readonly unknown[]): void {
    for (const raw of batch) {
      if (!Array.isArray(raw) || typeof raw[0] !== 'string') {
        this.#malformed++;
        continue;
      }
      const [name, ...argSets] = raw as [string, ...unknown[]];
      if (argSets.length === 0) {
        this.#apply(name, []);
        continue;
      }
      for (const args of argSets) {
        if (!Array.isArray(args)) {
          this.#malformed++;
          continue;
        }
        this.#apply(name, args);
      }
    }
  }

  #apply(name: string, args: readonly unknown[]): void {
    const event = parseUiEvent(name, args);
    if (!event) {
      this.#unhandled.set(name, (this.#unhandled.get(name) ?? 0) + 1);
      return;
    }
    this.applyEvent(event);
  }

  applyEvent(event: UiEvent): void {
    if ('grid' in event && event.grid !== GLOBAL_GRID) return;

    switch (event.kind) {
      case 'grid_resize':
        this.screen.gridResize(event.width, event.height);
        break;
      case 'grid_line':
        this.screen.gridLine(event.row, event.colStart, event.cells);
        break;
      case 'grid_clear':
        this.screen.gridClear();
        break;
      case 'grid_scroll':
        this.screen.gridScroll(event.top, event.bot, event.left, event.right, event.rows);
        break;
      case 'grid_cursor_goto':
        this.screen.gridCursorGoto(event.row, event.col);
        break;
      case 'hl_attr_define':
        this.screen.hlAttrDefine(event.id, event.attrs);
        break;
      case 'default_colors_set':
        this.screen.defaultColorsSet(event.fg, event.bg, event.sp);
        break;
      case 'mode_change':
        this.screen.modeChange(event.name, event.index);
        break;
      case 'flush':
        this.screen.flush();
        break;
    }
  }
}
