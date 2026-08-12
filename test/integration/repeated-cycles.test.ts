import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NeovimSession } from '../../src/session/session.js';
import { SessionManager } from '../../src/session/manager.js';
import { captureSnapshot, diffSnapshots } from '../../src/screen/diff.js';

const CYCLES = 12;

describe('repeated observe -> input -> observe cycles', () => {
  let manager: SessionManager;
  let workdir: string;

  beforeEach(async () => {
    manager = new SessionManager();
    workdir = await mkdtemp(join(tmpdir(), 'nvim-ui-mcp-cycles-'));
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
    // The intro banner occupies ~18 rows and clears only once the buffer is non-empty.
    // Priming past it keeps every measured cycle comparable.
    await session.input('iprimed<Esc>');
    await session.waitUntilNotContains('NVIM v');
    return session;
  };

  it(`stays in sync across ${CYCLES} cycles without leaking waiters or listeners`, async () => {
    const session = await launch();
    const listenersAtStart = session.nvim.listenerCount('notification');

    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      const word = `line${cycle}`;

      const before = captureSnapshot(session.screen);
      await session.input(`o${word}<Esc>`);
      await session.waitUntilContains(word);
      const after = captureSnapshot(session.screen);

      // The screen must show every line typed so far, in order.
      const lines = session.text().split('\n');
      for (let previous = 1; previous <= cycle; previous++) {
        expect(lines[previous]?.trimEnd(), `cycle ${cycle}, row ${previous}`).toBe(
          `line${previous}`,
        );
      }

      // Each cycle changes the screen, and the diff stays small.
      const diff = diffSnapshots(before, after);
      expect(diff.changed, `cycle ${cycle} produced no change`).toBe(true);
      expect(diff.rowChanges.length, `cycle ${cycle} diff too broad`).toBeLessThan(6);

      // Nothing accumulates between cycles.
      expect(session.pendingWaits, `cycle ${cycle} leaked a waiter`).toBe(0);
      expect(
        session.nvim.listenerCount('notification'),
        `cycle ${cycle} leaked a listener`,
      ).toBe(listenersAtStart);
      expect(session.processor.malformedEventCount, `cycle ${cycle} saw malformed events`).toBe(0);
    }

    // The screen is still coherent at the end: the primed line plus 12 typed lines.
    const finalLines = session.text().split('\n');
    expect(finalLines[0]?.trimEnd()).toBe('primed');
    expect(finalLines[CYCLES]?.trimEnd()).toBe(`line${CYCLES}`);
    expect(session.screen.consistent).toBe(true);
    expect(session.screen.flushCount).toBeGreaterThanOrEqual(CYCLES);
  });

  it('keeps a single Neovim process for the whole session', async () => {
    const session = await launch();
    const pid = session.process?.pid;

    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      const expected = `primed${'x'.repeat(cycle)}`;
      await session.input('ax<Esc>');
      // Wait on the expected content, not on a redraw event: content waits are
      // level-triggered, so they are immune to the redraw landing either before or
      // after the wait is registered.
      await session.waitUntilContains(expected);
      expect(session.text().split('\n')[0]?.trimEnd()).toBe(expected);
      expect(session.process?.pid).toBe(pid);
      expect(session.process?.exitCode).toBeNull();
    }
  });

  it('survives rapid input without desyncing from Neovim', async () => {
    const session = await launch();

    // Fire everything without waiting between keystrokes, then settle once.
    for (let cycle = 1; cycle <= CYCLES; cycle++) await session.input(`o${cycle}<Esc>`);
    await session.waitForIdle(150, 10_000);

    const lines = session.text().split('\n');
    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      expect(lines[cycle]?.trimEnd()).toBe(String(cycle));
    }
    expect(session.pendingWaits).toBe(0);

    // The shadow screen must agree with Neovim's own view of the buffer.
    const bufferLines = (await session.nvim.buffer.lines) as string[];
    expect(bufferLines).toEqual([
      'primed',
      ...Array.from({ length: CYCLES }, (_, index) => String(index + 1)),
    ]);
  });
});
