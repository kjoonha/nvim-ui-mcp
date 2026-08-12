/**
 * Step 1.5 kill-switch gate (throwaway script, not part of the test suite).
 *
 * Validates that the `neovim` npm client actually delivers `redraw` notifications
 * after `uiAttach` before any ShadowScreen work is invested. Run: `npm run smoke`.
 *
 * Uses process.stderr.write, not console.*: the `neovim` package monkey-patches
 * `console` onto a winston logger that is silent unless NVIM_NODE_LOG_FILE or
 * ALLOW_CONSOLE is set.
 */
import { spawn } from 'node:child_process';
import { attach } from 'neovim';

const NVIM = process.env.NVIM_BIN ?? 'nvim';
const TIMEOUT_MS = 10_000;

const log = (s: string): void => void process.stderr.write(`${s}\n`);

async function main(): Promise<void> {
  const proc = spawn(NVIM, ['--embed', '--clean', '-n'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const nvim = attach({ proc });

  const batches: unknown[][] = [];
  let sawGridLine = false;
  let sawFlush = false;

  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no qualifying redraw batch within ${TIMEOUT_MS}ms`)),
      TIMEOUT_MS,
    );

    nvim.on('notification', (method: string, args: unknown[]) => {
      if (method !== 'redraw') return;
      batches.push(args);
      for (const event of args as unknown[][]) {
        const name = Array.isArray(event) ? event[0] : undefined;
        if (name === 'grid_line') sawGridLine = true;
        if (name === 'flush') sawFlush = true;
      }
      if (sawGridLine && sawFlush) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  await nvim.uiAttach(80, 24, { ext_linegrid: true });

  await done;

  log('=== SMOKE: PASS ===');
  log(`batches received: ${batches.length}`);
  log(`grid_line seen: ${sawGridLine}, flush seen: ${sawFlush}`);

  const names = new Set<unknown>();
  for (const batch of batches) for (const event of batch as unknown[][]) names.add(event[0]);
  log(`--- event names across all batches ---\n${[...names].join(', ')}`);

  const sampleLine = batches.flat().find((e) => Array.isArray(e) && e[0] === 'grid_line');
  log(`--- sample grid_line event ---\n${JSON.stringify(sampleLine).slice(0, 1500)}`);

  const sampleResize = batches.flat().find((e) => Array.isArray(e) && e[0] === 'grid_resize');
  log(`--- sample grid_resize event ---\n${JSON.stringify(sampleResize)}`);

  const sampleMode = batches.flat().find((e) => Array.isArray(e) && e[0] === 'mode_change');
  log(`--- sample mode_change event ---\n${JSON.stringify(sampleMode)}`);

  await nvim.uiDetach();
  nvim.command('qa!').catch(() => undefined);

  await new Promise<void>((resolve) => {
    const kill = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve();
    }, 2000);
    proc.once('exit', () => {
      clearTimeout(kill);
      resolve();
    });
  });

  log(`nvim child exited, code=${proc.exitCode} signal=${proc.signalCode}`);
}

main().catch((err) => {
  log('=== SMOKE: FAIL ===');
  log(String(err instanceof Error ? err.stack : err));
  process.exitCode = 1;
});
