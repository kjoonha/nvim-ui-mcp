import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
const entry = join(repoRoot, 'src', 'index.ts');

export interface ToolCallResult {
  isError: boolean;
  text: string;
  structured: Record<string, unknown> | undefined;
}

interface JsonRpcResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/**
 * Drives the real server over stdio with newline-delimited JSON-RPC — the same wire
 * an MCP client uses. Nothing is stubbed: this exercises the actual protocol layer.
 */
export class McpTestClient {
  #proc: ChildProcess;
  #buffer = '';
  #nextId = 1;
  #pending = new Map<number, (response: JsonRpcResponse) => void>();
  #stderr = '';

  private constructor(proc: ChildProcess) {
    this.#proc = proc;
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => this.#onData(chunk));
    proc.stderr?.on('data', (chunk: Buffer) => {
      this.#stderr += chunk.toString('utf8');
    });
  }

  static async start(): Promise<McpTestClient> {
    const proc = spawn(tsxBin, [entry], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new McpTestClient(proc);
    await client.#request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'nvim-ui-mcp-test', version: '0.0.0' },
    });
    client.#notify('notifications/initialized');
    return client;
  }

  get stderr(): string {
    return this.#stderr;
  }

  async listTools(): Promise<string[]> {
    const result = await this.#request('tools/list', {});
    const tools = (result.tools ?? []) as { name: string }[];
    return tools.map((tool) => tool.name);
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    const result = await this.#request('tools/call', { name, arguments: args });
    const content = (result.content ?? []) as { type: string; text?: string }[];
    return {
      isError: result.isError === true,
      text: content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n'),
      structured: result.structuredContent as Record<string, unknown> | undefined,
    };
  }

  /** Call a tool that is expected to succeed, returning its structured payload. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const result = await this.callTool(name, args);
    if (result.isError) throw new Error(`${name} failed: ${result.text}`);
    if (!result.structured) throw new Error(`${name} returned no structured content`);
    return result.structured;
  }

  async stop(): Promise<void> {
    if (this.#proc.exitCode !== null || this.#proc.signalCode !== null) return;
    this.#proc.stdin?.end();
    this.#proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => {
        this.#proc.kill('SIGKILL');
        resolve();
      }, 5000);
      this.#proc.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
    });
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line) this.#dispatch(line);
      newline = this.#buffer.indexOf('\n');
    }
  }

  #dispatch(line: string): void {
    const message = JSON.parse(line) as JsonRpcResponse;
    if (message.id === undefined) return;
    const resolve = this.#pending.get(message.id);
    if (!resolve) return;
    this.#pending.delete(message.id);
    resolve(message);
  }

  #send(payload: Record<string, unknown>): void {
    this.#proc.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  #notify(method: string, params: Record<string, unknown> = {}): void {
    this.#send({ jsonrpc: '2.0', method, params });
  }

  async #request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.#nextId++;
    const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`MCP ${method} timed out. stderr:\n${this.#stderr}`));
      }, 30_000);
      this.#pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.#send({ jsonrpc: '2.0', id, method, params });
    });

    if (response.error) throw new Error(`MCP ${method} error: ${response.error.message}`);
    return response.result ?? {};
  }
}
