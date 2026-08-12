import type { NeovimSession } from './session.js';

export type WaitCondition =
  | { type: 'redraw' }
  | { type: 'screen-change' }
  | { type: 'idle'; idleMs: number }
  | { type: 'contains'; text: string }
  | { type: 'not-contains'; text: string };

export interface WaitOutcome {
  condition: WaitCondition['type'];
  waitedMs: number;
}

/**
 * Run one synchronization condition, bounded by `timeoutMs`.
 *
 * A timeout throws with the condition and the screen at the point of failure, so a
 * failed wait is diagnosable instead of a bare deadline message.
 */
export async function waitFor(
  session: NeovimSession,
  condition: WaitCondition,
  timeoutMs: number,
): Promise<WaitOutcome> {
  const started = Date.now();
  try {
    switch (condition.type) {
      case 'redraw':
        await session.waitForFlush(timeoutMs);
        break;
      case 'screen-change':
        await session.waitForScreenChange(timeoutMs);
        break;
      case 'idle':
        await session.waitForIdle(condition.idleMs, timeoutMs);
        break;
      case 'contains':
        await session.waitUntilContains(condition.text, timeoutMs);
        break;
      case 'not-contains':
        await session.waitUntilNotContains(condition.text, timeoutMs);
        break;
    }
  } catch (error) {
    throw new Error(
      `wait(${describe(condition)}) timed out after ${timeoutMs}ms: ${errorMessage(error)}\n` +
        `--- screen at timeout ---\n${session.text()}`,
    );
  }
  return { condition: condition.type, waitedMs: Date.now() - started };
}

function describe(condition: WaitCondition): string {
  switch (condition.type) {
    case 'idle':
      return `idle ${condition.idleMs}ms`;
    case 'contains':
      return `contains ${JSON.stringify(condition.text)}`;
    case 'not-contains':
      return `not-contains ${JSON.stringify(condition.text)}`;
    default:
      return condition.type;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
