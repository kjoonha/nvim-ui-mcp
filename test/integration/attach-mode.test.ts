import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NeovimSession } from '../../src/session/session.js';
import { SessionManager } from '../../src/session/manager.js';
import { McpTestClient } from '../helpers/mcp-client.js';

/**
 * Attach mode against a Neovim the test does not own: started externally with
 * `--listen`, connected over its RPC endpoint, and left running afterwards.
 */
describe('attach mode', () => {
  let manager: SessionManager;
  let workdir: string;
  let external: ChildProcess;
  let address: string;

  beforeEach(async () => {
    manager = new SessionManager();
    workdir = await mkdtemp(join(tmpdir(), 'nvim-ui-mcp-attach-'));
    address =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\nvim-ui-mcp-test-${process.pid}-${Date.now()}`
        : join(workdir, 'nvim.sock');

    // --headless is correct here: this instance's stdio is unused, we reach it
    // over the socket. --embed would make it wait for a UI on its own stdio.
    external = spawn('nvim', ['--headless', '-n', '--clean', '--listen', address], {
      cwd: workdir,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  });

  afterEach(async () => {
    await manager.closeAll();
    if (external.exitCode === null && external.signalCode === null) {
      external.kill('SIGKILL');
      await new Promise<void>((resolve) => external.once('exit', () => resolve()));
    }
    await rm(workdir, { recursive: true, force: true });
  });

  /** The listener is not up the instant the process spawns; retry until it answers. */
  const connect = async (): Promise<NeovimSession> => {
    const deadline = Date.now() + 15_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return manager.add(await NeovimSession.connect(address, { rows: 24, cols: 80 }));
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error(`could not attach to ${address}: ${String(lastError)}`);
  };

  it('attaches to a running instance and observes its screen', async () => {
    const session = await connect();

    expect(session.mode).toBe('attach');
    expect(session.process).toBeNull();
    await session.waitUntilContains('[No Name]');
    expect(session.screen.rows).toBe(24);
    expect(session.screen.cols).toBe(80);
    expect(session.processor.malformedEventCount).toBe(0);
  });

  it('drives the attached instance and sees the result', async () => {
    const session = await connect();
    await session.waitUntilContains('[No Name]');

    await session.input('iattached text<Esc>');
    await session.waitUntilContains('attached text');

    expect(session.text().split('\n')[0]?.trimEnd()).toBe('attached text');
    // The change is real: Neovim's own buffer agrees with the shadow screen.
    expect(await session.nvim.buffer.lines).toEqual(['attached text']);
  });

  it('leaves the instance running after the session closes', async () => {
    const session = await connect();
    await session.waitUntilContains('[No Name]');

    await manager.close(session.id);

    expect(session.closed).toBe(true);
    expect(external.exitCode).toBeNull();
    expect(external.signalCode).toBeNull();

    // Still usable by its real owner: a fresh session can attach again.
    const second = await connect();
    await second.waitUntilContains('[No Name]');
    expect(second.screen.rows).toBe(24);
  });

  it('refuses nvim_close for an attach-mode session over MCP', async () => {
    const client = await McpTestClient.start();
    try {
      const attached = await client.call('nvim_attach', { address, rows: 24, cols: 80 });
      expect(attached.mode).toBe('attach');

      const refused = await client.callTool('nvim_close', { sessionId: attached.sessionId });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('attach-mode');
      expect(refused.text).toContain('will not terminate it');

      // Refusing must not have killed it.
      expect(external.exitCode).toBeNull();

      // And the session is still usable after the refusal.
      const observation = await client.call('nvim_observe', { sessionId: attached.sessionId });
      expect(observation.screen).toContain('[No Name]');
    } finally {
      await client.stop();
    }
  });

  it('fails fast and names the address when nothing is listening', async () => {
    const bogus = join(workdir, 'not-a-socket');
    const started = Date.now();
    await expect(NeovimSession.connect(bogus)).rejects.toThrow(
      new RegExp(`cannot reach Neovim at ${bogus.replace(/[/\\]/g, '.')}`),
    );
    // It must not sit out the ui_attach timeout waiting for a socket that will never open.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
