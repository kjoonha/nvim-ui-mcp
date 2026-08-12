import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { SessionManager } from '../../session/manager.js';
import { NeovimSession } from '../../session/session.js';
import { jsonResult, runTool } from './shared.js';

const inputSchema = z.object({
  cwd: z.string().optional().describe('Working directory for the new instance.'),
  rows: z.number().int().min(1).max(500).optional().describe('Screen height. Default 24.'),
  cols: z.number().int().min(1).max(1000).optional().describe('Screen width. Default 80.'),
  clean: z
    .boolean()
    .optional()
    .describe('Start with --clean: no plugins, no shada, no user config. Recommended for tests.'),
  init: z.string().optional().describe('Path to an init file (-u). Ignored when clean is set.'),
  file: z.string().optional().describe('File to open on startup.'),
  args: z.array(z.string()).optional().describe('Extra Neovim arguments.'),
  nvimPath: z.string().optional().describe('Neovim executable. Defaults to nvim on PATH.'),
});

const outputSchema = z.object({
  sessionId: z.string(),
  mode: z.literal('test'),
  rows: z.number(),
  cols: z.number(),
  pid: z.number().nullable(),
});

export function registerLaunchTool(server: McpServer, manager: SessionManager): void {
  server.registerTool(
    'nvim_launch',
    {
      title: 'Launch Neovim',
      description:
        'Launch an isolated, disposable Neovim instance owned by this server and attach to it as a UI client. Returns a session id for the other tools. Use nvim_close when finished.',
      inputSchema,
      outputSchema,
    },
    async (args) =>
      runTool(async () => {
        const session = manager.add(await NeovimSession.launch(args));
        return jsonResult({
          sessionId: session.id,
          mode: 'test' as const,
          rows: session.screen.rows,
          cols: session.screen.cols,
          pid: session.process?.pid ?? null,
        });
      }),
  );
}
