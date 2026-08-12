import { McpServer } from '@modelcontextprotocol/server';
import { SessionManager } from '../session/manager.js';
import { registerAttachTool } from './tools/attach.js';
import { registerCloseTool } from './tools/close.js';
import { registerCommandTool } from './tools/command.js';
import { registerInputTool } from './tools/input.js';
import { registerLaunchTool } from './tools/launch.js';
import { registerObserveDiffTool } from './tools/observe-diff.js';
import { registerObserveTool } from './tools/observe.js';
import { registerWaitTool } from './tools/wait.js';

export const SERVER_INFO = {
  name: 'nvim-ui-mcp',
  version: '0.1.0',
  title: 'Neovim UI',
} as const;

/**
 * Build the MCP server over a session store.
 *
 * The store is a parameter rather than a module global because the stdio entry
 * constructs its server from a factory: every server built for a connection must
 * see the same live sessions.
 */
export function createServer(manager: SessionManager): McpServer {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });

  registerLaunchTool(server, manager);
  registerAttachTool(server, manager);
  registerObserveTool(server, manager);
  registerObserveDiffTool(server, manager);
  registerInputTool(server, manager);
  registerCommandTool(server, manager);
  registerWaitTool(server, manager);
  registerCloseTool(server, manager);

  return server;
}

export { SessionManager };
