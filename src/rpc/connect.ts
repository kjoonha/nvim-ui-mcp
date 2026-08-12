import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { attach, type NeovimClient } from 'neovim';

export const DEFAULT_NVIM_BIN = 'nvim';

export interface LaunchOptions {
  /** Working directory of the spawned instance. */
  cwd?: string;
  /** Start with `--clean` (no plugins, no shada, no user config). */
  clean?: boolean;
  /** Path to an init file, passed as `-u`. Ignored when `clean` is set. */
  init?: string;
  /** File to open on startup. */
  file?: string;
  /** Extra Neovim arguments, inserted before the file argument. */
  args?: string[];
  /** Neovim executable, defaults to `nvim` on PATH. */
  nvimPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface NeovimConnection {
  nvim: NeovimClient;
  /** The owned child process in test mode, `null` in attach mode. */
  proc: ChildProcess | null;
  /** The socket/named-pipe address in attach mode, `null` in test mode. */
  address: string | null;
  /** Most recent stderr output from the child, for diagnosing startup failures. */
  stderr(): string;
  /** Rejects if the transport dies. Never resolves. */
  failure: Promise<never>;
}

const STDERR_CAPTURE_LIMIT = 8192;

export function buildLaunchArgs(options: LaunchOptions): string[] {
  // `--embed` makes the child speak msgpack-RPC on its own stdio and expect a UI
  // client; `--headless` would suppress the UI entirely. `-n` disables swap files so
  // a disposable instance never blocks on a swap-file prompt.
  const args = ['--embed', '-n'];
  if (options.clean) args.push('--clean');
  else if (options.init) args.push('-u', options.init);
  if (options.args) args.push(...options.args);
  if (options.file) args.push(options.file);
  return args;
}

/** Test mode: spawn an instance this server owns and speak RPC over its stdio. */
export function launchNeovim(options: LaunchOptions = {}): NeovimConnection {
  const bin = options.nvimPath ?? DEFAULT_NVIM_BIN;
  const proc = spawn(bin, buildLaunchArgs(options), {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // stderr must be drained or a chatty child eventually blocks on a full pipe.
  let captured = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    if (captured.length < STDERR_CAPTURE_LIMIT) captured += chunk.toString('utf8');
  });

  const failure = new Promise<never>((_, reject) => {
    proc.once('error', (error: Error) => reject(new Error(`failed to spawn ${bin}: ${error.message}`)));
    proc.once('exit', (code, signal) =>
      reject(new Error(`${bin} exited (code=${code}, signal=${signal})${captured ? `: ${captured.trim()}` : ''}`)),
    );
  });
  // Consumers race this against their own work; keep it from ever being an unhandled rejection.
  failure.catch(() => undefined);

  return { nvim: attach({ proc }), proc, address: null, stderr: () => captured, failure };
}

/**
 * Windows named pipes must reach `net.connect()` with backslashes, but the path is
 * routinely passed around with forward slashes (shells, config files, copy/paste from
 * `:echo v:servername`). Unix socket paths are returned untouched.
 */
export function normalizePipeAddress(
  address: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return address;
  return /^[/\\]{2}[.?][/\\]pipe[/\\]/.test(address) ? address.replace(/\//g, '\\') : address;
}

/**
 * Attach mode: connect to an instance started by the user with `nvim --listen`.
 * `address` is a Unix socket path or a Windows named pipe (`\\.\pipe\...`); Node's
 * `net.connect()` accepts both, so one code path covers every platform.
 */
export async function connectToAddress(address: string): Promise<NeovimConnection> {
  // The socket is connected before the RPC client is built. `attach({ socket })` would
  // hand the client a socket that has not connected yet, and a refused connection then
  // escapes as an unhandled rejection from inside the client instead of failing here.
  const socket = await new Promise<Socket>((resolve, reject) => {
    const pending = createConnection({ path: normalizePipeAddress(address) });
    pending.once('connect', () => resolve(pending));
    pending.once('error', (error: Error) =>
      reject(new Error(`cannot reach Neovim at ${address}: ${error.message}`)),
    );
  });

  let lastError = '';
  const failure = new Promise<never>((_, reject) => {
    socket.on('error', (error: Error) => {
      lastError = error.message;
      reject(new Error(`lost connection to ${address}: ${error.message}`));
    });
    socket.once('close', () => reject(new Error(`connection to ${address} closed`)));
  });
  failure.catch(() => undefined);

  return {
    nvim: attach({ reader: socket, writer: socket }),
    proc: null,
    address,
    stderr: () => lastError,
    failure,
  };
}
