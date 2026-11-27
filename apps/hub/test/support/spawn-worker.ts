import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const HUB_DIR = fileURLToPath(new URL('../../', import.meta.url));
const READY_LINE = 'worker claiming steps';

/** A worker running as a child process, booted through the production entry point. */
export interface SpawnedWorker {
  /** Every structured line the worker has logged to stdout so far, oldest first. */
  logged(): Record<string, unknown>[];
  /** Kills the process with SIGKILL, as a crash would, and resolves once it has exited. */
  crash(): Promise<void>;
  /** Stops the process with SIGTERM if it is still running, and resolves once it has exited. */
  stop(): Promise<void>;
}

/**
 * Starts `src/worker-main.ts` in a child process with `env` over the process
 * environment, and resolves once it logs that it is claiming. The only way a
 * test can crash a worker for real (#5): a SIGKILL leaves no chance to clean up.
 */
export async function spawnWorker(env: Record<string, string>): Promise<SpawnedWorker> {
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', './src/instrumentation.ts', 'src/worker-main.ts'], {
    cwd: HUB_DIR,
    // A random metrics port, so workers spawned side by side never collide.
    env: { ...process.env, WORKER_PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    const onData = () => {
      if (stdout.includes(READY_LINE)) {
        child.stdout?.off('data', onData);
        child.off('exit', onExit);
        resolve();
      }
    };
    const onExit = (code: number | null) => reject(new Error(`worker process exited with ${code} before claiming; stderr: ${stderr}`));
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
  });
  return {
    logged: () =>
      stdout
        .split('\n')
        // The last piece is a line still being written, or empty.
        .slice(0, -1)
        .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line))),
    crash: () => end(child, 'SIGKILL'),
    stop: () => end(child, 'SIGTERM'),
  };
}

async function end(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill(signal);
  await exited;
}
