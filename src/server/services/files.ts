import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { config } from '../config.js';
import type { UserRow } from '../db.js';
import { HttpError, SysError } from '../errors.js';
import { sysPath } from '../sys/fsx.js';
import { homeOf } from './web.js';

const workerUrl = new URL(`../sys/fsworker.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url);
const workerPath = fileURLToPath(workerUrl);
// When running under tsx in development, the worker needs the same TypeScript loader.
const loaderArgs = workerPath.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : [];

function spawnWorker(user: UserRow, op: string, args: Record<string, unknown>) {
  const base = sysPath(homeOf(user.username));
  const asUser = !config.dryRun && user.uid != null && user.gid != null;
  return spawn(process.execPath, [...loaderArgs, '--disable-warning=ExperimentalWarning', workerPath, base, op, JSON.stringify(args)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(asUser ? { uid: user.uid!, gid: user.gid! } : {}),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: base },
    cwd: '/',
  });
}

/** Run a worker op that returns JSON. */
export function fileOp<T = unknown>(user: UserRow, op: string, args: Record<string, unknown>, stdin?: Readable | string): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawnWorker(user, op, args);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new SysError('Could not start file worker', e.message)));
    child.on('close', (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(out || 'null') as T);
        } catch {
          reject(new SysError('File worker returned invalid output'));
        }
        return;
      }
      let msg = 'File operation failed.';
      try {
        msg = (JSON.parse(err) as { error: string }).error;
      } catch {
        /* keep default */
      }
      reject(new HttpError(400, msg));
    });
    if (typeof stdin === 'string') child.stdin.end(stdin);
    else if (stdin) stdin.pipe(child.stdin);
    else child.stdin.end();
  });
}

/** Stream a file out of the account's home directory. Resolves once the first bytes (or an error) arrive. */
export function downloadStream(user: UserRow, rel: string): Promise<Readable> {
  return new Promise((resolve, reject) => {
    const child = spawnWorker(user, 'download', { path: rel });
    child.stdin.end();
    let err = '';
    let settled = false;
    child.stderr.on('data', (d) => (err += d));
    child.stdout.once('readable', () => {
      if (!settled) {
        settled = true;
        resolve(child.stdout);
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) return resolve(child.stdout);
      let msg = 'Download failed.';
      try {
        msg = (JSON.parse(err) as { error: string }).error;
      } catch {
        /* default */
      }
      reject(new HttpError(400, msg));
    });
  });
}
