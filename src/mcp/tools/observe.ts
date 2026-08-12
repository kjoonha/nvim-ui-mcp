import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { SessionManager } from '../../session/manager.js';
import { buildObservation } from '../../session/observation.js';
import { cursorSchema, modeSchema, observationResult, runTool, sessionIdSchema } from './shared.js';

const inputSchema = z.object({ sessionId: sessionIdSchema });

const outputSchema = z.object({
  sessionId: z.string(),
  screen: z.string(),
  rows: z.number(),
  cols: z.number(),
  cursor: cursorSchema,
  mode: modeSchema,
  buffer: z.object({ id: z.number(), name: z.string() }),
  window: z.object({ id: z.number() }),
  floats: z.array(
    z.object({
      winId: z.number(),
      relative: z.string(),
      row: z.number(),
      col: z.number(),
      width: z.number(),
      height: z.number(),
      zindex: z.number().nullable(),
    }),
  ),
});

export function registerObserveTool(server: McpServer, manager: SessionManager): void {
  server.registerTool(
    'nvim_observe',
    {
      title: 'Observe Neovim',
      description:
        'Return the rendered Neovim screen as plain text rows, plus cursor, mode, size, current buffer/window and floating-window geometry. The screen is the source of truth; the metadata explains it. Rows are plain text with no cursor markers or line numbers, so substring matching is reliable. Resets the nvim_observe_diff baseline.',
      inputSchema,
      outputSchema,
    },
    async ({ sessionId }) =>
      runTool(async () => {
        const observation = await buildObservation(manager.get(sessionId));
        return observationResult(observation.screen, { ...observation });
      }),
  );
}
