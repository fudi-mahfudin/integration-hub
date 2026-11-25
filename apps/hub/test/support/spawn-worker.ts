import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HUB_DIR = fileURLToPath(new URL('../..', import.meta.url));
const READY = 'worker claiming steps';

export interface ChildWorker {
  pid: number;
  /** SIGKILL: no drain, no cleanup, exactly like a crashed process. */
  kill(): void;
  /** Resolves once the process has exited. */
  exited: Promise<void>;
}

/**
 * Runs the production worker entry point (`src/worker-main.ts`, under tsx) as
 * a child process with the environment plus `overrides`; resolves once it
 * claims. Only the lease-recovery tests need this (#5); kill it in afterEach.
 */
export async function spawnWorker(overrides: Record<string, string>): Promise<ChildWorker> {
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/worker-main.ts'], {
    cwd: HUB_DIR,
    env: { ...process.env, ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(READY)) resolve();
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.once('exit', (code) => reject(new Error(`worker exited (${code}) before claiming:\n${output}`)));
  });
  // Keep draining so a chatty worker never blocks on a full pipe.
  child.stdout!.resume();
  child.stderr!.resume();
  return {
    pid: child.pid!,
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
    exited,
  };
}
