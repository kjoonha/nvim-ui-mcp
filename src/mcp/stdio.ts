import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { SessionManager } from '../session/manager.js';
import { createServer } from './server.js';

/**
 * Diagnostics must go to stderr: this process's stdout carries MCP JSON-RPC framing.
 * `console` is unusable here — the `neovim` package replaces it with a logger that is
 * silent unless NVIM_NODE_LOG_FILE or ALLOW_CONSOLE is set.
 */
function logError(message: string): void {
  process.stderr.write(`[nvim-ui-mcp] ${message}\n`);
}

export function main(): void {
  const manager = new SessionManager();
  const handle = serveStdio(() => createServer(manager), {
    onerror: (error) => logError(error.message),
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Every instance this server launched dies with it; attach-mode sessions are
    // only detached, since those belong to the user.
    void manager
      .closeAll()
      .catch((error: unknown) => logError(`shutdown: ${String(error)}`))
      .finally(() => {
        void handle.close();
        process.exit(signal === 'SIGINT' ? 130 : 143);
      });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}
