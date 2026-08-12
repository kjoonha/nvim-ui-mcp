import type { NeovimClient } from 'neovim';
import type { ChildProcess } from 'node:child_process';
import {
  connectToAddress,
  launchNeovim,
  type LaunchOptions,
  type NeovimConnection,
} from '../rpc/connect.js';
import { ShadowScreen } from '../screen/shadow-screen.js';
import { serializeScreen } from '../screen/serializer.js';
import {
  captureSnapshot,
  diffSnapshots,
  type ScreenDiff,
  type ScreenSnapshot,
} from '../screen/diff.js';
import { UiEventProcessor } from '../ui/event-processor.js';

export type SessionMode = 'test' | 'attach';

export interface SessionSize {
  rows?: number;
  cols?: number;
}

export type LaunchSessionOptions = LaunchOptions & SessionSize;

export const DEFAULT_SIZE = { rows: 24, cols: 80 } as const;

/** Grace period for a test-mode instance to exit on its own before it is killed. */
const EXIT_GRACE_MS = 2000;

/** Upper bound on `nvim_ui_attach`, so a wrong binary or dead socket fails instead of hanging. */
const ATTACH_TIMEOUT_MS = 10_000;

/** Upper bound on any single best-effort RPC call issued during shutdown. */
const RPC_SHUTDOWN_MS = 1000;

let sessionCounter = 0;

/**
 * One attached Neovim instance: process/connection lifecycle, the UI event pipeline,
 * and the synchronization primitives observation is built on.
 */
export class NeovimSession {
  readonly id: string;
  readonly mode: SessionMode;
  readonly screen: ShadowScreen;
  readonly processor: UiEventProcessor;

  readonly #connection: NeovimConnection;
  readonly #flushWaiters = new Set<() => void>();
  #closed = false;
  #exited = false;
  #lastObservation: ScreenSnapshot | null = null;
  #lastRedrawAt = Date.now();

  private constructor(
    id: string,
    mode: SessionMode,
    connection: NeovimConnection,
    size: Required<SessionSize>,
  ) {
    this.id = id;
    this.mode = mode;
    this.#connection = connection;
    this.screen = new ShadowScreen(size.rows, size.cols);
    this.processor = new UiEventProcessor(this.screen);

    connection.proc?.once('error', () => {
      this.#exited = true;
    });
    connection.proc?.once('exit', () => {
      this.#exited = true;
      this.#releaseWaiters();
    });
  }

  static async launch(options: LaunchSessionOptions = {}): Promise<NeovimSession> {
    const size = resolveSize(options);
    const session = new NeovimSession(nextId(), 'test', launchNeovim(options), size);
    await session.#attachUi(size);
    return session;
  }

  static async connect(address: string, options: SessionSize = {}): Promise<NeovimSession> {
    const size = resolveSize(options);
    const session = new NeovimSession(nextId(), 'attach', await connectToAddress(address), size);
    await session.#attachUi(size);
    return session;
  }

  get nvim(): NeovimClient {
    return this.#connection.nvim;
  }

  get process(): ChildProcess | null {
    return this.#connection.proc;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Waiters still parked on a frame. Should return to 0 after every wait settles. */
  get pendingWaits(): number {
    return this.#flushWaiters.size;
  }

  /** Rendered screen text. Callers wanting a torn-free frame should wait for consistency first. */
  text(): string {
    return serializeScreen(this.screen);
  }

  async input(keys: string): Promise<number> {
    return this.nvim.input(keys);
  }

  async command(command: string): Promise<void> {
    await this.nvim.command(command);
  }

  /**
   * Wait out a partially-applied frame so a reader never sees a torn screen.
   * A frame that never closes is not an error: the last flushed content is still
   * the best available answer, so observation degrades rather than failing.
   */
  async ensureConsistent(timeoutMs = 2000): Promise<void> {
    if (this.screen.consistent || this.#closed) return;
    try {
      await this.waitForFlush(timeoutMs);
    } catch {
      // Fall through and read the most recent complete frame.
    }
  }

  /** Snapshot the screen and make it the baseline for the next diff. */
  markObserved(): ScreenSnapshot {
    const snapshot = captureSnapshot(this.screen);
    this.#lastObservation = snapshot;
    return snapshot;
  }

  /** Difference since the previous observation, re-baselining to the current screen. */
  diffSinceObserved(): ScreenDiff {
    const previous = this.#lastObservation ?? captureSnapshot(this.screen);
    const current = this.markObserved();
    return diffSnapshots(previous, current);
  }

  /** Resolve on the next completed frame. */
  waitForFlush(timeoutMs = 5000): Promise<void> {
    if (this.#closed) return Promise.reject(new Error(`session ${this.id} is closed`));
    return new Promise((resolve, reject) => {
      const waiter = (): void => {
        clearTimeout(timer);
        this.#flushWaiters.delete(waiter);
        if (this.#exited) reject(new Error(`session ${this.id}: Neovim exited while waiting for a redraw`));
        else resolve();
      };
      const timer = setTimeout(() => {
        this.#flushWaiters.delete(waiter);
        reject(new Error(`session ${this.id}: no redraw within ${timeoutMs}ms`));
      }, timeoutMs);
      this.#flushWaiters.add(waiter);
    });
  }

  /** Resolve once `predicate` holds on a consistent screen, or reject on timeout. */
  async waitUntilScreen(
    predicate: (screen: ShadowScreen) => boolean,
    timeoutMs = 5000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    if (this.screen.consistent && predicate(this.screen)) return;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        await this.waitForFlush(remaining);
      } catch {
        break;
      }
      if (predicate(this.screen)) return;
    }
    throw new Error(`session ${this.id}: screen condition not met within ${timeoutMs}ms`);
  }

  waitUntilContains(needle: string, timeoutMs = 5000): Promise<void> {
    return this.waitUntilScreen((screen) => serializeScreen(screen).includes(needle), timeoutMs);
  }

  waitUntilNotContains(needle: string, timeoutMs = 5000): Promise<void> {
    return this.waitUntilScreen((screen) => !serializeScreen(screen).includes(needle), timeoutMs);
  }

  /** Resolve once the rendered text differs from what it is at the moment of the call. */
  waitForScreenChange(timeoutMs = 5000): Promise<void> {
    const baseline = serializeScreen(this.screen);
    return this.waitUntilScreen((screen) => serializeScreen(screen) !== baseline, timeoutMs);
  }

  /**
   * Resolve once no redraw batch has arrived for `idleMs`. This is the robust choice
   * when an action triggers several frames (debounced renders, async LSP round trips).
   */
  async waitForIdle(idleMs: number, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const quietFor = Date.now() - this.#lastRedrawAt;
      if (quietFor >= idleMs) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(idleMs - quietFor, remaining));
    }
    throw new Error(`session ${this.id}: never idle for ${idleMs}ms within ${timeoutMs}ms`);
  }

  /**
   * Detach the UI and, in test mode only, terminate the instance. Attach-mode sessions
   * belong to the user, so the instance is left running.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    const { nvim, proc } = this.#connection;
    nvim.removeListener('notification', this.#onNotification);

    if (!this.#exited) {
      await settleWithin(nvim.uiDetach(), RPC_SHUTDOWN_MS);
      if (this.mode === 'test') {
        // Deliberately not awaited: Neovim exits before replying to `qa!`, so the
        // request promise never settles.
        void nvim.command('qa!').catch(() => undefined);
      }
    }

    if (proc) await this.#awaitExit(proc);
    // A child's pipes die with it, and ending an already-dead writer never completes.
    // Only a still-live transport (attach mode) needs an explicit close.
    if (!this.#exited) await settleWithin(nvim.close(), RPC_SHUTDOWN_MS);
    this.#releaseWaiters();
  }

  async #attachUi(size: Required<SessionSize>): Promise<void> {
    // Subscribe before attaching so the first redraw batch cannot be missed.
    const { nvim, failure } = this.#connection;
    nvim.on('notification', this.#onNotification);

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no response within ${ATTACH_TIMEOUT_MS}ms`)),
        ATTACH_TIMEOUT_MS,
      );
    });

    // The race can settle on `failure` first, after which the transport rejects this
    // request too; without a handler that late rejection escapes as an unhandled one.
    const attachRequest = nvim.uiAttach(size.cols, size.rows, { ext_linegrid: true });
    attachRequest.catch(() => undefined);

    try {
      await Promise.race([attachRequest, failure, timeout]);
    } catch (error) {
      await this.close();
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`session ${this.id}: nvim_ui_attach failed: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }

  #onNotification = (method: string, args: unknown[]): void => {
    if (method !== 'redraw') return;
    this.#lastRedrawAt = Date.now();
    const before = this.screen.flushCount;
    this.processor.handleRedraw(args);
    if (this.screen.flushCount > before) this.#releaseWaiters();
  };

  #releaseWaiters(): void {
    const waiters = [...this.#flushWaiters];
    this.#flushWaiters.clear();
    for (const waiter of waiters) waiter();
  }

  async #awaitExit(proc: ChildProcess): Promise<void> {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, EXIT_GRACE_MS);
      proc.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
    });
  }
}

function nextId(): string {
  sessionCounter += 1;
  return `nvim-${sessionCounter}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveSize(options: SessionSize): Required<SessionSize> {
  return { rows: options.rows ?? DEFAULT_SIZE.rows, cols: options.cols ?? DEFAULT_SIZE.cols };
}

/** Shutdown is best-effort: a dying RPC channel may neither answer nor reject. */
function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}
