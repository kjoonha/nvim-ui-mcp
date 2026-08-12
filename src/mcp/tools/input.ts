import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { SessionManager } from '../../session/manager.js';
import { jsonResult, runTool, sessionIdSchema } from './shared.js';

const inputSchema = z.object({
  sessionId: sessionIdSchema,
  keys: z
    .string()
    .min(1)
    .describe(
      'Key sequence in Neovim notation, e.g. "ihello<Esc>", "<C-n>", "gg", "<leader>ff". Sent through nvim_input, so mappings and pending state behave exactly as for a human.',
    ),
});

const outputSchema = z.object({
  sessionId: z.string(),
  keys: z.string(),
  bytesWritten: z.number(),
});

export function registerInputTool(server: McpServer, manager: SessionManager): void {
  server.registerTool(
    'nvim_input',
    {
      title: 'Send input to Neovim',
      description:
        'Send a key sequence to Neovim. Returns as soon as the keys are queued, not when the screen has updated: follow with nvim_wait before observing, otherwise the observation races the redraw.',
      inputSchema,
      outputSchema,
    },
    async ({ sessionId, keys }) =>
      runTool(async () => {
        const session = manager.get(sessionId);
        const bytesWritten = await session.input(keys);
        return jsonResult({ sessionId: session.id, keys, bytesWritten });
      }),
  );
}
