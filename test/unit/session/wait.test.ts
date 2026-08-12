import { describe, expect, it, vi } from 'vitest';
import { waitFor, type WaitCondition } from '../../../src/session/wait.js';
import type { NeovimSession } from '../../../src/session/session.js';

interface StubCalls {
  waitForFlush: ReturnType<typeof vi.fn>;
  waitForScreenChange: ReturnType<typeof vi.fn>;
  waitForIdle: ReturnType<typeof vi.fn>;
  waitUntilContains: ReturnType<typeof vi.fn>;
  waitUntilNotContains: ReturnType<typeof vi.fn>;
}

function stubSession(screen = 'SCREEN'): { session: NeovimSession; calls: StubCalls } {
  const calls: StubCalls = {
    waitForFlush: vi.fn().mockResolvedValue(undefined),
    waitForScreenChange: vi.fn().mockResolvedValue(undefined),
    waitForIdle: vi.fn().mockResolvedValue(undefined),
    waitUntilContains: vi.fn().mockResolvedValue(undefined),
    waitUntilNotContains: vi.fn().mockResolvedValue(undefined),
  };
  return { session: { ...calls, text: () => screen } as unknown as NeovimSession, calls };
}

describe('waitFor dispatch', () => {
  it('routes redraw to waitForFlush', async () => {
    const { session, calls } = stubSession();
    await waitFor(session, { type: 'redraw' }, 1234);
    expect(calls.waitForFlush).toHaveBeenCalledWith(1234);
  });

  it('routes screen-change to waitForScreenChange', async () => {
    const { session, calls } = stubSession();
    await waitFor(session, { type: 'screen-change' }, 1000);
    expect(calls.waitForScreenChange).toHaveBeenCalledWith(1000);
  });

  it('passes both the quiet period and the timeout to waitForIdle', async () => {
    const { session, calls } = stubSession();
    await waitFor(session, { type: 'idle', idleMs: 50 }, 900);
    expect(calls.waitForIdle).toHaveBeenCalledWith(50, 900);
  });

  it('routes contains and not-contains with their needle', async () => {
    const { session, calls } = stubSession();
    await waitFor(session, { type: 'contains', text: 'hi' }, 500);
    await waitFor(session, { type: 'not-contains', text: 'bye' }, 500);
    expect(calls.waitUntilContains).toHaveBeenCalledWith('hi', 500);
    expect(calls.waitUntilNotContains).toHaveBeenCalledWith('bye', 500);
  });

  it('reports the condition and elapsed time', async () => {
    const { session } = stubSession();
    const outcome = await waitFor(session, { type: 'redraw' }, 100);
    expect(outcome.condition).toBe('redraw');
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(0);
  });
});

describe('waitFor timeouts', () => {
  const failing = (screen: string): NeovimSession =>
    ({
      waitForFlush: vi.fn().mockRejectedValue(new Error('no redraw within 10ms')),
      waitForScreenChange: vi.fn().mockRejectedValue(new Error('unchanged')),
      waitForIdle: vi.fn().mockRejectedValue(new Error('never idle')),
      waitUntilContains: vi.fn().mockRejectedValue(new Error('not found')),
      waitUntilNotContains: vi.fn().mockRejectedValue(new Error('still present')),
      text: () => screen,
    }) as unknown as NeovimSession;

  it('includes the screen so a failed wait is diagnosable', async () => {
    await expect(waitFor(failing('ROW1\nROW2'), { type: 'redraw' }, 10)).rejects.toThrow(
      /screen at timeout[\s\S]*ROW1[\s\S]*ROW2/,
    );
  });

  it.each<[WaitCondition, RegExp]>([
    [{ type: 'redraw' }, /wait\(redraw\)/],
    [{ type: 'screen-change' }, /wait\(screen-change\)/],
    [{ type: 'idle', idleMs: 42 }, /wait\(idle 42ms\)/],
    [{ type: 'contains', text: 'needle' }, /wait\(contains "needle"\)/],
    [{ type: 'not-contains', text: 'gone' }, /wait\(not-contains "gone"\)/],
  ])('names the condition in the error for %o', async (condition, pattern) => {
    await expect(waitFor(failing('S'), condition, 10)).rejects.toThrow(pattern);
  });

  it('reports the timeout budget', async () => {
    await expect(waitFor(failing('S'), { type: 'redraw' }, 250)).rejects.toThrow(
      /timed out after 250ms/,
    );
  });
});
