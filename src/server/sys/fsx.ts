import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { dryLog } from './exec.js';

/** Map an absolute system path to where it lives. In dry-run mode everything goes under <dataDir>/dryroot. */
export function sysPath(p: string): string {
  if (!path.isAbsolute(p)) throw new Error(`sysPath needs an absolute path: ${p}`);
  return config.dryRun ? path.join(config.dataDir, 'dryroot', p) : p;
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(sysPath(p));
    return true;
  } catch {
    return false;
  }
}

export async function readText(p: string): Promise<string | null> {
  try {
    return await fs.readFile(sysPath(p), 'utf8');
  } catch {
    return null;
  }
}

/** Write a file atomically (temp file + rename). */
export async function writeAtomic(p: string, content: string, mode = 0o644): Promise<void> {
  const target = sysPath(p);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.vex-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, content, { mode });
  await fs.chmod(tmp, mode);
  await fs.rename(tmp, target);
  if (config.dryRun) dryLog(`write ${p} (${content.length} bytes)`);
}

export async function removePath(p: string): Promise<void> {
  await fs.rm(sysPath(p), { recursive: true, force: true });
  if (config.dryRun) dryLog(`rm -rf ${p}`);
}

export async function ensureDir(p: string, mode = 0o755): Promise<void> {
  await fs.mkdir(sysPath(p), { recursive: true, mode });
}

/**
 * Write a config file and run a check. If the check fails the previous content is restored,
 * so a bad render never leaves a broken service config on disk.
 */
export async function writeChecked(p: string, content: string, check: () => Promise<void>, mode = 0o644): Promise<void> {
  const previous = await readText(p);
  await writeAtomic(p, content, mode);
  try {
    await check();
  } catch (err) {
    if (previous === null) await removePath(p);
    else await writeAtomic(p, previous, mode);
    throw err;
  }
}
