import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { SessionManager } from '../../session/manager.js';
import { cursorSchema, jsonResult, modeSchema, runTool, sessionIdSchema, sizeSchema } from './shared.js';

const inputSchema = z.object({ sessionId: sessionIdSchema });

const outputSchema = z.object({
  sessionId: z.string(),
  changed: z.boolean(),
  rowChanges: z.array(
    z.object({
      row: z.number(),
      before: z.string().nullable(),
      after: z.string().nullable(),
    }),
  ),
  cursor: z.object({ before: cursorSchema, after: cursorSchema }).optional(),
  mode: z.object({ before: modeSchema, after: modeSchema }).optional(),
  size: z.object({ before: sizeSchema, after: sizeSchema }).optional(),
});

export function registerObserveDiffTool(server: McpServer, manager: SessionManager): void {
  server.registerTool(
    'nvim_observe_diff',
    {
      title: 'Observe Neovim diff',
      description:
        'Return only what changed since the last observation: changed screen rows with their before/after text, plus cursor, mode and size deltas. Much smaller than a full nvim_observe for verifying a single action. Resets the baseline.',
      inputSchema,
      outputSchema,
    },
    async ({ sessionId }) =>
      runTool(async () => {
        const session = manager.get(sessionId);
        await session.ensureConsistent();
        return jsonResult({ sessionId: session.id, ...session.diffSinceObserved() });
      }),
  );
}
