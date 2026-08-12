import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NeovimSession } from '../../src/session/session.js';
import { SessionManager } from '../../src/session/manager.js';
import { captureSnapshot, diffSnapshots } from '../../src/screen/diff.js';

/**
 * The vertical slice: launch -> msgpack-RPC connect -> nvim_ui_attach -> initial redraw
 * -> shadow screen -> input -> redraw -> observe -> assert -> clean shutdown.
 */
/** Every pid this file spawns; none may outlive the suite. */
const spawnedPids: number[] = [];

describe('vertical slice: launch, observe, input, observe', () => {
  let manager: SessionManager;
  let workdir: string;

  beforeEach(async () => {
    manager = new SessionManager();
    workdir = await mkdtemp(join(tmpdir(), 'nvim-ui-mcp-'));
  });

  afterEach(async () => {
    await manager.closeAll();
    await rm(workdir, { recursive: true, force: true });
  });

  const launch = async (): Promise<NeovimSession> => {
    const session = manager.add(
      await NeovimSession.launch({ cwd: workdir, clean: true, rows: 24, cols: 80 }),
    );
    const pid = session.process?.pid;
    if (pid !== undefined) spawnedPids.push(pid);
    await session.waitUntilScreen((screen) => screen.rows === 24 && screen.cols === 80);
    return session;
  };

  it('receives the initial redraw and builds a consistent screen', async () => {
    const session = await launch();

    expect(session.mode).toBe('test');
    expect(session.screen.rows).toBe(24);
    expect(session.screen.cols).toBe(80);
    expect(session.screen.consistent).toBe(true);
    expect(session.screen.flushCount).toBeGreaterThan(0);
    expect(session.processor.malformedEventCount).toBe(0);

    // Highlights and default colors arrive with the first frame.
    expect(session.screen.highlights.size).toBeGreaterThan(0);
    expect(session.screen.defaultColors.fg).not.toBe(-1);

    // The status line of an empty buffer.
    await session.waitUntilContains('[No Name]');
    const lines = session.text().split('\n');
    expect(lines).toHaveLength(24);
    expect(lines.every((line) => [...line].length <= 80)).toBe(true);
    expect(session.screen.mode.name).toBe('normal');
  });

  it('reflects typed input in the rendered screen', async () => {
    const session = await launch();
    const before = captureSnapshot(session.screen);

    await session.input('ihello<Esc>');
    await session.waitUntilScreen(
      (screen) => screen.mode.name === 'normal' && screen.row(0)[0]?.text === 'h',
    );

    const lines = session.text().split('\n');
    expect(lines[0]).toBe(`hello${' '.repeat(75)}`);
    expect(session.screen.mode).toEqual({ name: 'normal', index: 0 });
    expect(session.screen.cursor).toEqual({ row: 0, col: 4 });

    const diff = diffSnapshots(before, captureSnapshot(session.screen));
    expect(diff.changed).toBe(true);
    expect(diff.rowChanges.some((change) => change.after?.startsWith('hello'))).toBe(true);
  });

  it('observes multiple lines and reports insert mode while typing', async () => {
    const session = await launch();

    await session.input('ione<CR>two');
    await session.waitUntilScreen((screen) => screen.mode.name === 'insert');
    expect(session.screen.mode.name).toBe('insert');

    await session.input('<Esc>');
    await session.waitUntilScreen((screen) => screen.mode.name === 'normal');

    const lines = session.text().split('\n');
    expect(lines[0]?.trimEnd()).toBe('one');
    expect(lines[1]?.trimEnd()).toBe('two');
  });

  it('reflects an Ex command in the rendered screen', async () => {
    const session = await launch();

    await session.input('ialpha<Esc>');
    await session.waitUntilContains('alpha');
    await session.command('set number');
    await session.waitUntilScreen((screen) => screen.row(0)[0]?.text === ' ');

    expect(session.text().split('\n')[0]?.trimEnd()).toBe('  1 alpha');
  });

  it('renders double-width characters at the correct columns', async () => {
    const session = await launch();

    await session.input('i한글<Esc>');
    await session.waitUntilContains('한글');

    const row = session.screen.row(0);
    expect(row.slice(0, 5).map((cell) => cell.text)).toEqual(['한', '', '글', '', ' ']);
    expect(session.text().split('\n')[0]?.trimEnd()).toBe('한글');
  });

  it('shuts down cleanly, leaving no orphan process', async () => {
    const session = await launch();
    const proc = session.process;
    expect(proc).not.toBeNull();
    const pid = proc?.pid;
    expect(pid).toBeGreaterThan(0);

    await manager.close(session.id);

    expect(session.closed).toBe(true);
    expect(proc?.exitCode !== null || proc?.signalCode !== null).toBe(true);
    expect(manager.has(session.id)).toBe(false);
    expect(isAlive(pid!)).toBe(false);
  });

  it('rejects screen waits once the session is closed', async () => {
    const session = await launch();
    await manager.close(session.id);
    await expect(session.waitForFlush(50)).rejects.toThrow(/closed/);
  });
});

describe('attach-mode boundary', () => {
  it('refuses to launch when the Neovim binary does not exist', async () => {
    await expect(
      NeovimSession.launch({ nvimPath: 'definitely-not-nvim', clean: true }),
    ).rejects.toThrow(/nvim_ui_attach failed/);
  });
});

function isAlive(pid: number): boolean {
  try {
    // Signal 0 performs existence/permission checking without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Nothing this suite spawned may survive it.
afterAll(() => {
  expect(spawnedPids.length).toBeGreaterThan(0);
  const orphans = spawnedPids.filter(isAlive);
  expect(orphans, `orphan Neovim pids: ${orphans.join(', ')}`).toHaveLength(0);
});
