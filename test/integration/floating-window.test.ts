import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NeovimSession } from '../../src/session/session.js';
import { SessionManager } from '../../src/session/manager.js';
import { buildObservation } from '../../src/session/observation.js';

/**
 * With ext_linegrid and no ext_multigrid, Neovim composites floats into the single
 * grid. These tests check that the composited result lands at the right coordinates
 * and that the float metadata lets an agent tell a float from buffer text.
 */
describe('floating windows', () => {
  let manager: SessionManager;
  let workdir: string;

  beforeEach(async () => {
    manager = new SessionManager();
    workdir = await mkdtemp(join(tmpdir(), 'nvim-ui-mcp-float-'));
  });

  afterEach(async () => {
    await manager.closeAll();
    await rm(workdir, { recursive: true, force: true });
  });

  const launch = async (): Promise<NeovimSession> => {
    const session = manager.add(
      await NeovimSession.launch({ cwd: workdir, clean: true, rows: 24, cols: 80 }),
    );
    await session.waitUntilContains('[No Name]');
    return session;
  };

  const openFloat = async (
    session: NeovimSession,
    options: { row: number; col: number; width: number; height: number; lines: string[] },
  ): Promise<number> => {
    const winId = await session.nvim.lua(
      `
      local row, col, width, height, lines = ...
      local buf = vim.api.nvim_create_buf(false, true)
      vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
      return vim.api.nvim_open_win(buf, false, {
        relative = 'editor', row = row, col = col,
        width = width, height = height, style = 'minimal',
      })
      `,
      [options.row, options.col, options.width, options.height, options.lines],
    );
    return winId as number;
  };

  it('renders float content at the requested grid position', async () => {
    const session = await launch();
    await openFloat(session, { row: 5, col: 10, width: 12, height: 1, lines: ['FLOATING'] });
    await session.waitUntilContains('FLOATING');

    const lines = session.text().split('\n');
    expect(lines[5]?.slice(10, 18)).toBe('FLOATING');
    // Rows above and below the float are untouched by it.
    expect(lines[4]).not.toContain('FLOATING');
    expect(lines[6]).not.toContain('FLOATING');
  });

  it('reports float geometry so an agent can tell a float from buffer text', async () => {
    const session = await launch();
    const winId = await openFloat(session, {
      row: 3,
      col: 20,
      width: 15,
      height: 2,
      lines: ['popup line 1', 'popup line 2'],
    });
    await session.waitUntilContains('popup line 2');

    const observation = await buildObservation(session);
    expect(observation.floats).toHaveLength(1);
    expect(observation.floats[0]).toMatchObject({
      winId,
      relative: 'editor',
      row: 3,
      col: 20,
      width: 15,
      height: 2,
    });

    // The float's content is in the composited screen at the reported coordinates.
    const lines = observation.screen.split('\n');
    expect(lines[3]?.slice(20, 32)).toBe('popup line 1');
    expect(lines[4]?.slice(20, 32)).toBe('popup line 2');
  });

  it('renders a multi-row float over existing buffer text', async () => {
    const session = await launch();
    await session.input('i<CR>'.repeat(0) + 'ibuffer text here<Esc>');
    await session.waitUntilContains('buffer text here');

    await openFloat(session, { row: 0, col: 7, width: 6, height: 1, lines: ['COVER'] });
    await session.waitUntilContains('COVER');

    const row0 = session.text().split('\n')[0] ?? '';
    // Neovim composited the float over the buffer row: the covered text is gone.
    expect(row0.slice(0, 7)).toBe('buffer ');
    expect(row0.slice(7, 12)).toBe('COVER');
    expect(row0).not.toContain('buffer text here');
  });

  it('tracks several floats and drops them when they close', async () => {
    const session = await launch();
    const first = await openFloat(session, {
      row: 2,
      col: 2,
      width: 8,
      height: 1,
      lines: ['ALPHA'],
    });
    const second = await openFloat(session, {
      row: 8,
      col: 40,
      width: 8,
      height: 1,
      lines: ['BETA'],
    });
    await session.waitUntilContains('BETA');

    const withFloats = await buildObservation(session);
    expect(withFloats.floats.map((float) => float.winId).sort()).toEqual([first, second].sort());
    expect(withFloats.screen.split('\n')[2]?.slice(2, 7)).toBe('ALPHA');
    expect(withFloats.screen.split('\n')[8]?.slice(40, 44)).toBe('BETA');

    await session.nvim.lua('vim.api.nvim_win_close(..., true)', [first]);
    await session.waitUntilNotContains('ALPHA');

    const afterClose = await buildObservation(session);
    expect(afterClose.floats.map((float) => float.winId)).toEqual([second]);
  });

  it('renders double-width characters inside a float at the right columns', async () => {
    const session = await launch();
    await openFloat(session, { row: 4, col: 6, width: 10, height: 1, lines: ['한글x'] });
    await session.waitUntilContains('한글');

    const row = session.screen.row(4);
    expect(row.slice(6, 11).map((cell) => cell.text)).toEqual(['한', '', '글', '', 'x']);
    // Serialization collapses the continuation cells, preserving display width.
    expect(session.text().split('\n')[4]?.slice(6, 9)).toBe('한글x');
  });
});
