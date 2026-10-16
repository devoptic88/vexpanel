import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { SysError } from '../errors.js';

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunOptions {
  input?: string;
  /** Resolve instead of throwing on a non-zero exit. */
  allowFail?: boolean;
  /** In dry-run mode, return this instead of logging a no-op. */
  dryRunResult?: Partial<RunResult>;
  timeoutMs?: number;
}

/** Log a line describing what a real system would have done. */
export function dryLog(line: string) {
  mkdirSync(config.dataDir, { recursive: true });
  appendFileSync(path.join(config.dataDir, 'dryrun.log'), `${new Date().toISOString()} ${line}\n`);
}

/**
 * Run a system command without a shell. Arguments are passed as an array, so nothing
 * in them is interpreted by a shell. In dry-run mode the command is only logged.
 */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  if (config.dryRun) {
    // Never log stdin: it can contain passwords.
    dryLog(`$ ${cmd} ${args.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ')}${opts.input !== undefined ? ' <stdin>' : ''}`);
    return Promise.resolve({ stdout: '', stderr: '', code: 0, ...opts.dryRunResult });
  }
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { maxBuffer: 16 * 1024 * 1024, timeout: opts.timeoutMs ?? 120_000, env: { ...process.env, LC_ALL: 'C' } },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
        if (err && !opts.allowFail) {
          reject(new SysError(`${cmd} ${args[0] ?? ''} failed`, (stderr || stdout || err.message).toString().trim().slice(0, 2000)));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr), code });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/**
 * FIFO lock so system-level changes (config writes + reloads) never interleave.
 * Re-entrant: a serial() call made from inside another serial() runs immediately.
 */
const inLock = new AsyncLocalStorage<boolean>();
let chain: Promise<unknown> = Promise.resolve();
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  if (inLock.getStore()) return fn();
  const wrapped = () => inLock.run(true, fn);
  const next = chain.then(wrapped, wrapped);
  chain = next.catch(() => undefined);
  return next;
}
