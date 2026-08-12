import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { SessionManager } from '../../session/manager.js';
import { jsonResult, runTool, sessionIdSchema } from './shared.js';

const inputSchema = z.object({ sessionId: sessionIdSchema });

const outputSchema = z.object({
  sessionId: z.string(),
  closed: z.boolean(),
});

export function registerCloseTool(server: McpServer, manager: SessionManager): void {
  server.registerTool(
    'nvim_close',
    {
      title: 'Close a Neovim session',
      description:
        'Terminate a Neovim instance this server launched and release its session. Refuses attach-mode sessions: that instance belongs to the user, and attach sessions are released when the server shuts down.',
      inputSchema,
      outputSchema,
    },
    async ({ sessionId }) =>
      runTool(async () => {
        const session = manager.get(sessionId);
        if (session.mode === 'attach') {
          throw new Error(
            `session ${session.id} is attach-mode: this server does not own that Neovim instance and will not terminate it.`,
          );
        }
        await manager.close(session.id);
        return jsonResult({ sessionId: session.id, closed: true });
      }),
  );
}
