import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { SessionManager } from '../../session/manager.js';
import { NeovimSession } from '../../session/session.js';
import { jsonResult, runTool } from './shared.js';

const inputSchema = z.object({
  address: z
    .string()
    .min(1)
    .describe(
      'RPC endpoint of a running Neovim, as printed by `nvim --listen`: a Unix socket path (/tmp/nvim.sock) or a Windows named pipe (\\\\.\\pipe\\nvim.1234.0).',
    ),
  rows: z.number().int().min(1).max(500).optional().describe('Requested screen height.'),
  cols: z.number().int().min(1).max(1000).optional().describe('Requested screen width.'),
});

const outputSchema = z.object({
  sessionId: z.string(),
  mode: z.literal('attach'),
  address: z.string(),
  rows: z.number(),
  cols: z.number(),
});

export function registerAttachTool(server: McpServer, manager: SessionManager): void {
  server.registerTool(
    'nvim_attach',
    {
      title: 'Attach to Neovim',
      description:
        'Attach as an additional UI to an already-running Neovim instance. The instance belongs to the user: nvim_close will refuse to terminate it. Note that Neovim sizes the screen to the smallest attached UI, so the requested size can shrink what the user sees.',
      inputSchema,
      outputSchema,
    },
    async ({ address, rows, cols }) =>
      runTool(async () => {
        const session = manager.add(await NeovimSession.connect(address, { rows, cols }));
        return jsonResult({
          sessionId: session.id,
          mode: 'attach' as const,
          address,
          rows: session.screen.rows,
          cols: session.screen.cols,
        });
      }),
  );
}
