import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpTestClient } from '../helpers/mcp-client.js';

/**
 * Step 4 end to end: the real server, driven over stdio with real JSON-RPC,
 * against a real Neovim. Nothing here is stubbed.
 */
describe('MCP tool surface', () => {
  let client: McpTestClient;
  let workdir: string;

  beforeAll(async () => {
    client = await McpTestClient.start();
    workdir = await mkdtemp(join(tmpdir(), 'nvim-ui-mcp-tools-'));
  });

  afterAll(async () => {
    await client.stop();
    await rm(workdir, { recursive: true, force: true });
  });

  const launch = async (): Promise<string> => {
    const result = await client.call('nvim_launch', { cwd: workdir, clean: true });
    return result.sessionId as string;
  };

  it('exposes exactly the eight MVP tools', async () => {
    expect((await client.listTools()).sort()).toEqual([
      'nvim_attach',
      'nvim_close',
      'nvim_command',
      'nvim_input',
      'nvim_launch',
      'nvim_observe',
      'nvim_observe_diff',
      'nvim_wait',
    ]);
  });

  it('launches a configurable instance', async () => {
    const result = await client.call('nvim_launch', { cwd: workdir, clean: true, rows: 30, cols: 100 });
    expect(result.mode).toBe('test');
    expect(result.rows).toBe(30);
    expect(result.cols).toBe(100);
    expect(result.pid).toBeTypeOf('number');

    const observation = await client.call('nvim_observe', { sessionId: result.sessionId });
    expect(observation.rows).toBe(30);
    expect(observation.cols).toBe(100);
    expect((observation.screen as string).split('\n')).toHaveLength(30);

    await client.call('nvim_close', { sessionId: result.sessionId });
  });

  it('returns a hybrid observation', async () => {
    const sessionId = await launch();

    const observation = await client.call('nvim_observe', { sessionId });
    expect(observation.screen).toContain('[No Name]');
    expect(observation.cursor).toEqual({ row: 0, col: 0 });
    expect(observation.mode).toEqual({ name: 'normal', index: 0 });
    expect(observation.buffer).toEqual({ id: expect.any(Number), name: '' });
    expect(observation.window).toEqual({ id: expect.any(Number) });
    expect(observation.floats).toEqual([]);

    await client.call('nvim_close', { sessionId });
  });

  it('drives the observe -> act -> wait -> observe loop', async () => {
    const sessionId = await launch();

    await client.call('nvim_observe', { sessionId });
    await client.call('nvim_input', { sessionId, keys: 'ihello world<Esc>' });
    await client.call('nvim_wait', { sessionId, condition: 'contains', text: 'hello world' });

    const observation = await client.call('nvim_observe', { sessionId });
    expect((observation.screen as string).split('\n')[0]?.trimEnd()).toBe('hello world');
    expect(observation.mode).toEqual({ name: 'normal', index: 0 });

    await client.call('nvim_close', { sessionId });
  });

  it('reports a compact diff since the last observation', async () => {
    const sessionId = await launch();

    await client.call('nvim_observe', { sessionId });
    await client.call('nvim_input', { sessionId, keys: 'ialpha<Esc>' });
    await client.call('nvim_wait', { sessionId, condition: 'contains', text: 'alpha' });

    const diff = await client.call('nvim_observe_diff', { sessionId });
    expect(diff.changed).toBe(true);
    const rowChanges = diff.rowChanges as { row: number; after: string }[];
    expect(rowChanges.some((change) => change.after.startsWith('alpha'))).toBe(true);
    // A diff is meant to be far smaller than the full screen.
    expect(rowChanges.length).toBeLessThan(24);

    const unchanged = await client.call('nvim_observe_diff', { sessionId });
    expect(unchanged.changed).toBe(false);
    expect(unchanged.rowChanges).toEqual([]);

    await client.call('nvim_close', { sessionId });
  });

  it('executes Ex commands and surfaces Neovim errors', async () => {
    const sessionId = await launch();

    await client.call('nvim_input', { sessionId, keys: 'ialpha<Esc>' });
    await client.call('nvim_wait', { sessionId, condition: 'contains', text: 'alpha' });
    await client.call('nvim_command', { sessionId, command: 'set number' });
    await client.call('nvim_wait', { sessionId, condition: 'contains', text: '1 alpha' });

    const observation = await client.call('nvim_observe', { sessionId });
    expect((observation.screen as string).split('\n')[0]?.trimEnd()).toBe('  1 alpha');

    const failure = await client.callTool('nvim_command', {
      sessionId,
      command: 'ThisCommandDoesNotExist',
    });
    expect(failure.isError).toBe(true);
    expect(failure.text).toMatch(/E492|Not an editor command/);

    await client.call('nvim_close', { sessionId });
  });

  it('validates tool input at the schema boundary', async () => {
    const missingArg = await client.callTool('nvim_input', { sessionId: 'nvim-1' });
    expect(missingArg.isError).toBe(true);

    const unknownSession = await client.callTool('nvim_observe', { sessionId: 'no-such-session' });
    expect(unknownSession.isError).toBe(true);
    expect(unknownSession.text).toContain('unknown session');
  });

  it('rejects a wait condition that is missing its text argument', async () => {
    const sessionId = await launch();
    const result = await client.callTool('nvim_wait', { sessionId, condition: 'contains' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('requires the text parameter');
    await client.call('nvim_close', { sessionId });
  });

  it('closes a test-mode session and forgets it', async () => {
    const sessionId = await launch();

    const closed = await client.call('nvim_close', { sessionId });
    expect(closed).toEqual({ sessionId, closed: true });

    const afterClose = await client.callTool('nvim_observe', { sessionId });
    expect(afterClose.isError).toBe(true);
    expect(afterClose.text).toContain('unknown session');
  });

  it('never writes anything but JSON-RPC to stdout', async () => {
    const sessionId = await launch();
    await client.call('nvim_input', { sessionId, keys: 'ihi<Esc>' });
    await client.call('nvim_wait', { sessionId, condition: 'idle', idleMs: 50 });
    await client.call('nvim_close', { sessionId });
    // Every stdout line has already been JSON.parse'd by the client; a stray write
    // would have thrown during dispatch.
    expect(await client.listTools()).toHaveLength(8);
  });
});
