import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { SessionManager } from '../../session/manager.js';
import { jsonResult, runTool, sessionIdSchema } from './shared.js';

const inputSchema = z.object({
  sessionId: sessionIdSchema,
  command: z
    .string()
    .min(1)
    .describe('Ex command without the leading colon, e.g. "set number", "edit foo.txt", "wq".'),
});

const outputSchema = z.object({
  sessionId: z.string(),
  command: z.string(),
  ok: z.boolean(),
});

export function registerCommandTool(server: McpServer, manager: SessionManager): void {
  server.registerTool(
    'nvim_command',
    {
      title: 'Run an Ex command',
      description:
        'Execute an Ex command. A command that Neovim rejects comes back as an error result with Neovim\'s own message. Like nvim_input, this does not wait for the screen to settle.',
      inputSchema,
      outputSchema,
    },
    async ({ sessionId, command }) =>
      runTool(async () => {
        const session = manager.get(sessionId);
        await session.command(command);
        return jsonResult({ sessionId: session.id, command, ok: true });
      }),
  );
}
