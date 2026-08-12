import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { SessionManager } from '../../session/manager.js';
import { waitFor, type WaitCondition } from '../../session/wait.js';
import { jsonResult, runTool, sessionIdSchema } from './shared.js';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_IDLE_MS = 100;

const inputSchema = z.object({
  sessionId: sessionIdSchema,
  condition: z
    .enum(['redraw', 'screen-change', 'idle', 'contains', 'not-contains'])
    .describe(
      'redraw: next completed frame. screen-change: rendered text differs from now. idle: no redraw for idleMs, the safest choice after an action that triggers several frames. contains/not-contains: wait for text to appear/disappear on screen.',
    ),
  text: z.string().optional().describe('Required for contains and not-contains.'),
  idleMs: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`Quiet period for the idle condition. Default ${DEFAULT_IDLE_MS}.`),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`Give up after this long. Default ${DEFAULT_TIMEOUT_MS}.`),
});

const outputSchema = z.object({
  sessionId: z.string(),
  condition: z.string(),
  waitedMs: z.number(),
});

type WaitArgs = z.infer<typeof inputSchema>;

function toCondition(args: WaitArgs): WaitCondition {
  switch (args.condition) {
    case 'contains':
    case 'not-contains':
      if (args.text === undefined) {
        throw new Error(`condition "${args.condition}" requires the text parameter`);
      }
      return { type: args.condition, text: args.text };
    case 'idle':
      return { type: 'idle', idleMs: args.idleMs ?? DEFAULT_IDLE_MS };
    default:
      return { type: args.condition };
  }
}

export function registerWaitTool(server: McpServer, manager: SessionManager): void {
  server.registerTool(
    'nvim_wait',
    {
      title: 'Wait for Neovim',
      description:
        'Block until a screen condition holds, so an observation is not raced against the redraw it is meant to see. On timeout the error includes the screen as it was, so a failed wait is diagnosable.',
      inputSchema,
      outputSchema,
    },
    async (args) =>
      runTool(async () => {
        const session = manager.get(args.sessionId);
        const outcome = await waitFor(
          session,
          toCondition(args),
          args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );
        return jsonResult({ sessionId: session.id, ...outcome });
      }),
  );
}
