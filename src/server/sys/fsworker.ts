/**
 * File-manager worker. The panel spawns this process with the hosting account's uid/gid,
 * so the kernel enforces what the account can touch — the panel never reads or writes
 * customer files as root.
 *
 * Usage: node fsworker.js <base> <op> <json-args>
 * Content for write/upload arrives on stdin; read/download write to stdout.
 * Every other op prints one JSON line.
 */
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const [, , rawBase, op, rawArgs] = process.argv;
const base = path.resolve(rawBase);
const args = JSON.parse(rawArgs || '{}') as Record<string, unknown>;

class UserFacing extends Error {}

async function realBase() {
  return fs.realpath(base);
}

/** Resolve a relative path inside base; the deepest existing ancestor must also resolve inside base. */
async function resolve(rel: unknown, { mustExist = false } = {}): Promise<string> {
  const clean = String(rel ?? '').replace(/^\/+/, '');
  const abs = path.resolve(base, clean);
  const rb = await realBase();
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new UserFacing('Path is outside your home directory.');
  let probe = abs;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (real !== rb && !real.startsWith(rb + path.sep)) throw new UserFacing('Path is outside your home directory.');
      break;
    } catch (e) {
      if (e instanceof UserFacing) throw e;
      if (mustExist && probe === abs) throw new UserFacing('File or folder not found.');
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return abs;
}

function isBinary(buf: Buffer) {
  return buf.subarray(0, 8000).includes(0);
}

async function main() {
  switch (op) {
    case 'list': {
      const dir = await resolve(args.path, { mustExist: true });
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const out = [];
      for (const e of entries) {
        try {
          const st = await fs.lstat(path.join(dir, e.name));
          out.push({
            name: e.name,
            type: st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file',
            size: st.size,
            mtime: st.mtime.toISOString(),
            mode: (st.mode & 0o777).toString(8).padStart(3, '0'),
          });
        } catch {
          /* vanished */
        }
      }
      out.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
      return print(out);
    }
    case 'read': {
      const p = await resolve(args.path, { mustExist: true });
      const st = await fs.stat(p);
      if (!st.isFile()) throw new UserFacing('Not a file.');
      if (st.size > 2 * 1024 * 1024) throw new UserFacing('File is larger than 2 MB; download it instead.');
      const buf = await fs.readFile(p);
      if (isBinary(buf)) throw new UserFacing('This looks like a binary file; download it instead.');
      return print({ content: buf.toString('utf8') });
    }
    case 'write':
    case 'upload': {
      const p = await resolve(args.path);
      try {
        if ((await fs.lstat(p)).isSymbolicLink()) throw new UserFacing('Refusing to write through a symbolic link.');
      } catch (e) {
        if (e instanceof UserFacing) throw e;
      }
      await pipeline(process.stdin, createWriteStream(p, { mode: 0o644 }));
      const st = await fs.stat(p);
      return print({ ok: true, size: st.size });
    }
    case 'download': {
      const p = await resolve(args.path, { mustExist: true });
      const st = await fs.stat(p);
      if (!st.isFile()) throw new UserFacing('Not a file.');
      await pipeline(createReadStream(p), process.stdout);
      return;
    }
    case 'mkdir': {
      const p = await resolve(args.path);
      await fs.mkdir(p, { recursive: Boolean(args.recursive), mode: 0o755 });
      return print({ ok: true });
    }
    case 'rename': {
      const from = await resolve(args.from, { mustExist: true });
      const to = await resolve(args.to);
      if (from === base) throw new UserFacing('Cannot move your home directory.');
      try {
        await fs.lstat(to);
        throw new UserFacing('Something with that name already exists.');
      } catch (e) {
        if (e instanceof UserFacing) throw e;
      }
      await fs.rename(from, to);
      return print({ ok: true });
    }
    case 'remove': {
      const paths = (args.paths as unknown[]) ?? [];
      for (const rel of paths) {
        const p = await resolve(rel, { mustExist: true });
        if (p === base) throw new UserFacing('Cannot delete your home directory.');
        await fs.rm(p, { recursive: true, force: false });
      }
      return print({ ok: true });
    }
    case 'chmod': {
      const p = await resolve(args.path, { mustExist: true });
      const mode = String(args.mode ?? '');
      if (!/^[0-7]{3}$/.test(mode)) throw new UserFacing('Permissions must be three octal digits, like 644.');
      if ((await fs.lstat(p)).isSymbolicLink()) throw new UserFacing('Cannot change permissions of a symbolic link.');
      await fs.chmod(p, parseInt(mode, 8));
      return print({ ok: true });
    }
    case 'du': {
      return print({ bytes: await du(base) });
    }
    default:
      throw new UserFacing(`Unknown operation ${op}`);
  }
}

async function du(p: string): Promise<number> {
  let total = 0;
  const st = await fs.lstat(p).catch(() => null);
  if (!st) return 0;
  total += st.blocks ? st.blocks * 512 : st.size;
  if (st.isDirectory()) {
    const entries = await fs.readdir(p).catch(() => [] as string[]);
    for (const e of entries) total += await du(path.join(p, e));
  }
  return total;
}

function print(v: unknown) {
  process.stdout.write(JSON.stringify(v));
}

main().catch((e: NodeJS.ErrnoException) => {
  const msg =
    e instanceof UserFacing
      ? e.message
      : e.code === 'EACCES' || e.code === 'EPERM'
        ? 'Permission denied.'
        : e.code === 'ENOENT'
          ? 'File or folder not found.'
          : e.code === 'EEXIST'
            ? 'Something with that name already exists.'
            : e.code === 'ENOTEMPTY'
              ? 'Folder is not empty.'
              : e.code === 'EDQUOT'
                ? 'Disk quota exceeded.'
                : 'File operation failed.';
  process.stderr.write(JSON.stringify({ error: msg }));
  process.exit(2);
});
