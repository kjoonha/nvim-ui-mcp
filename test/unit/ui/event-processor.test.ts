import { beforeEach, describe, expect, it } from 'vitest';
import { UiEventProcessor } from '../../../src/ui/event-processor.js';
import { parseUiEvent } from '../../../src/ui/events.js';
import { ShadowScreen } from '../../../src/screen/shadow-screen.js';
import { serializeRow } from '../../../src/screen/serializer.js';

let screen: ShadowScreen;
let processor: UiEventProcessor;

beforeEach(() => {
  screen = new ShadowScreen(4, 10);
  processor = new UiEventProcessor(screen);
});

const text = (row: number): string => serializeRow(screen.row(row));

describe('redraw batch shape', () => {
  it('applies every argSet of a multi-invocation event', () => {
    processor.handleRedraw([
      [
        'grid_line',
        [1, 0, 0, [['a', 0]], false],
        [1, 1, 0, [['b', 0]], false],
        [1, 2, 0, [['c', 0]], false],
      ],
    ]);
    expect([text(0), text(1), text(2)]).toEqual(['a         ', 'b         ', 'c         ']);
  });

  it('applies events in batch order', () => {
    processor.handleRedraw([
      ['grid_line', [1, 0, 0, [['x', 0, 10]], false]],
      ['grid_clear', [1]],
      ['grid_line', [1, 0, 0, [['y', 0]], false]],
    ]);
    expect(text(0)).toBe('y         ');
  });

  it('handles a zero-argument event such as flush', () => {
    processor.handleRedraw([['flush', []]]);
    expect(screen.flushCount).toBe(1);
    expect(screen.consistent).toBe(true);
  });

  it('handles an event array with no argSets at all', () => {
    processor.handleRedraw([['flush']]);
    expect(screen.flushCount).toBe(1);
  });
});

describe('grid_resize', () => {
  it('resizes to (width, height) argument order', () => {
    processor.handleRedraw([['grid_resize', [1, 20, 5]]]);
    expect(screen.cols).toBe(20);
    expect(screen.rows).toBe(5);
  });
});

describe('grid_line', () => {
  it('decodes repeat runs and implicit highlight reuse', () => {
    processor.handleRedraw([
      ['grid_line', [1, 0, 0, [[' ', 0, 3], ['N', 5], ['V'], ['I'], ['M'], ['.', 7, 3]], false]],
    ]);
    expect(text(0)).toBe('   NVIM...');
    expect(screen.row(0).map((c) => c.hlId)).toEqual([0, 0, 0, 5, 5, 5, 5, 7, 7, 7]);
  });

  it('decodes double-width cells emitted as an empty continuation string', () => {
    processor.handleRedraw([['grid_line', [1, 0, 0, [['글', 0], [''], ['!', 0]], false]]]);
    expect(screen.row(0).slice(0, 3).map((c) => c.text)).toEqual(['글', '', '!']);
    expect(text(0)).toBe('글!       ');
  });

  it('starts at colStart', () => {
    processor.handleRedraw([['grid_line', [1, 1, 4, [['z', 2]], false]]]);
    expect(text(1)).toBe('    z     ');
  });
});

describe('grid_clear, grid_scroll and grid_cursor_goto', () => {
  it('clears the whole grid', () => {
    processor.handleRedraw([
      ['grid_line', [1, 0, 0, [['#', 1, 10]], false]],
      ['grid_clear', [1]],
    ]);
    expect(text(0)).toBe('          ');
  });

  it('scrolls the requested region', () => {
    processor.handleRedraw([
      ['grid_line', [1, 0, 0, [['a', 0, 10]], false]],
      ['grid_line', [1, 1, 0, [['b', 0, 10]], false]],
      ['grid_scroll', [1, 0, 2, 0, 10, 1, 0]],
    ]);
    expect(text(0)).toBe('bbbbbbbbbb');
  });

  it('moves the cursor', () => {
    processor.handleRedraw([['grid_cursor_goto', [1, 2, 6]]]);
    expect(screen.cursor).toEqual({ row: 2, col: 6 });
  });
});

describe('hl_attr_define, default_colors_set and mode_change', () => {
  it('stores highlight attributes', () => {
    processor.handleRedraw([
      ['hl_attr_define', [4, { foreground: 16777215, bold: true }, { bold: true }, []]],
    ]);
    expect(screen.highlights.get(4)).toEqual({
      rgb: { foreground: 16777215, bold: true },
      cterm: { bold: true },
      info: [],
    });
  });

  it('stores default colors', () => {
    processor.handleRedraw([['default_colors_set', [16777215, 0, 16711680, 231, 0]]]);
    expect(screen.defaultColors).toEqual({ fg: 16777215, bg: 0, sp: 16711680 });
  });

  it('stores the current mode', () => {
    processor.handleRedraw([['mode_change', ['insert', 3]]]);
    expect(screen.mode).toEqual({ name: 'insert', index: 3 });
  });
});

describe('flush consistency gate', () => {
  it('leaves the screen inconsistent for a batch without a flush', () => {
    processor.handleRedraw([['grid_line', [1, 0, 0, [['a', 0]], false]]]);
    expect(screen.consistent).toBe(false);
  });

  it('marks the screen consistent once the batch ends with a flush', () => {
    processor.handleRedraw([
      ['grid_line', [1, 0, 0, [['a', 0]], false]],
      ['flush', []],
    ]);
    expect(screen.consistent).toBe(true);
  });

  it('reopens the frame when a new batch mutates the grid', () => {
    processor.handleRedraw([['flush', []]]);
    processor.handleRedraw([['grid_line', [1, 0, 0, [['a', 0]], false]]]);
    expect(screen.consistent).toBe(false);
  });
});

describe('dirty row tracking', () => {
  it('records the rows a batch touched', () => {
    processor.handleRedraw([
      ['grid_line', [1, 1, 0, [['a', 0]], false], [1, 3, 0, [['b', 0]], false]],
      ['flush', []],
    ]);
    expect([...screen.dirtyRows].sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it('resets at the start of the next frame', () => {
    processor.handleRedraw([['grid_line', [1, 1, 0, [['a', 0]], false]], ['flush', []]]);
    processor.handleRedraw([['grid_line', [1, 2, 0, [['b', 0]], false]], ['flush', []]]);
    expect([...screen.dirtyRows]).toEqual([2]);
  });
});

describe('robustness', () => {
  it('ignores events for grids other than the composited global grid', () => {
    processor.handleRedraw([['grid_line', [2, 0, 0, [['x', 0, 10]], false]]]);
    expect(text(0)).toBe('          ');
  });

  it('counts unknown events instead of throwing', () => {
    processor.handleRedraw([
      ['win_viewport', [1, 1000, 0, 1, 0, 1, 0, 0]],
      ['mouse_on', []],
      ['mouse_on', []],
      ['flush', []],
    ]);
    expect(processor.unhandledEvents.get('win_viewport')).toBe(1);
    expect(processor.unhandledEvents.get('mouse_on')).toBe(2);
    expect(screen.flushCount).toBe(1);
  });

  it('counts malformed entries instead of throwing', () => {
    processor.handleRedraw([null, 42, ['grid_line', 'not-an-argset'], ['flush', []]]);
    expect(processor.malformedEventCount).toBe(3);
    expect(screen.flushCount).toBe(1);
  });

  it('treats an event with bad argument types as unhandled', () => {
    processor.handleRedraw([['grid_resize', ['x', 'y', 'z']]]);
    expect(processor.unhandledEvents.get('grid_resize')).toBe(1);
    expect(screen.cols).toBe(10);
  });

  it('survives a real Neovim startup batch', () => {
    processor.handleRedraw([
      ['option_set', ['arabicshape', true], ['ambiwidth', 'single']],
      ['set_title', ['nvim']],
      ['hl_attr_define', [1, {}, {}, [{ kind: 'ui', ui_name: 'EndOfBuffer' }]]],
      ['grid_resize', [1, 10, 4]],
      ['grid_clear', [1]],
      ['default_colors_set', [16777215, 0, 16711680, 231, 0]],
      ['grid_line', [1, 0, 0, [[' ', 0, 10]], false], [1, 1, 0, [['~', 18], [' ', 18, 9]], false]],
      ['win_viewport', [1, 1000, 0, 1, 0, 1, 0, 0]],
      ['grid_cursor_goto', [1, 0, 0]],
      ['mode_info_set', [true, []]],
      ['mode_change', ['normal', 0]],
      ['mouse_on', []],
      ['flush', []],
    ]);

    expect(screen.rows).toBe(4);
    expect(screen.cols).toBe(10);
    expect(text(1)).toBe('~         ');
    expect(screen.mode).toEqual({ name: 'normal', index: 0 });
    expect(screen.consistent).toBe(true);
    expect(processor.malformedEventCount).toBe(0);
  });
});

describe('parseUiEvent', () => {
  it('returns null for unknown event names', () => {
    expect(parseUiEvent('win_float_pos', [])).toBeNull();
  });

  it('returns null when grid_line cells are malformed', () => {
    expect(parseUiEvent('grid_line', [1, 0, 0, [[42]], false])).toBeNull();
  });

  it('omits hlId and repeat when absent so the screen can reuse the previous hlId', () => {
    expect(parseUiEvent('grid_line', [1, 0, 0, [['a', 3, 2], ['b']], false])).toEqual({
      kind: 'grid_line',
      grid: 1,
      row: 0,
      colStart: 0,
      cells: [{ text: 'a', hlId: 3, repeat: 2 }, { text: 'b' }],
    });
  });
});
