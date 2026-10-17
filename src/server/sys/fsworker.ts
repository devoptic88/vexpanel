/**
 * File-manager worker. The panel spawns this process with the hosting account's uid/gid,
 * so the kernel enforces what the account can touch — the panel never reads or writes
 * customer files as root.
 *
 * Usage: node fsworker.js <base> <op> <json-args>
 * Content for write/upload arrives on stdin; read/download write to stdout.
 * Every other op prints one JSON line.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
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

    // ---- App installer ops ----
    case 'fetch': {
      // Download a package into the account's home. Size-capped; redirects followed.
      const dest = await resolve(args.path);
      const max = Number(args.maxBytes ?? 600 * 1024 * 1024);
      const res = await fetch(String(args.url), { redirect: 'follow', headers: { 'user-agent': 'VEXPANEL app installer' }, signal: AbortSignal.timeout(15 * 60_000) });
      if (!res.ok || !res.body) throw new UserFacing(`Download failed: the server answered ${res.status}.`);
      let seen = 0;
      const cap = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          seen += chunk.length;
          if (seen > max) cb(new UserFacing('The package is larger than the size limit.'));
          else cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), cap, createWriteStream(dest, { mode: 0o600 }));
      return print({ ok: true, bytes: seen });
    }
    case 'extract': {
      // Unpack an archive and move the app's files into an empty target folder.
      const archive = await resolve(args.archive, { mustExist: true });
      const target = await resolve(args.target);
      if (target === base) throw new UserFacing('Choose a folder inside your home directory.');
      await ensureEmptyTarget(target);
      const stage = await resolve(`tmp/vex-extract-${randomBytes(6).toString('hex')}`);
      await fs.mkdir(stage, { recursive: true, mode: 0o700 });
      try {
        await unpack(archive, stage);
        const src = await locateApp(stage, args.subdir as string | undefined);
        await fs.mkdir(target, { recursive: true, mode: 0o755 });
        let n = 0;
        for (const name of await fs.readdir(src)) {
          await fs.rename(path.join(src, name), path.join(target, name));
          n++;
        }
        if (n === 0) throw new UserFacing('The package was empty.');
        await normalizeModes(target);
        return print({ ok: true, entries: n });
      } finally {
        await fs.rm(stage, { recursive: true, force: true });
      }
    }
    case 'rmtree': {
      // Remove an installed app. contentsOnly keeps the folder itself (used for a web root).
      const target = await resolve(args.path, { mustExist: true });
      if (target === base) throw new UserFacing('Refusing to remove your home directory.');
      if (args.contentsOnly) {
        const keep = new Set((args.keep as string[] | undefined) ?? []);
        for (const name of await fs.readdir(target)) {
          if (!keep.has(name)) await fs.rm(path.join(target, name), { recursive: true, force: true });
        }
      } else {
        await fs.rm(target, { recursive: true, force: true });
      }
      return print({ ok: true });
    }
    case 'exists': {
      const p = await resolve(args.path);
      try {
        const st = await fs.lstat(p);
        return print({ exists: true, dir: st.isDirectory(), size: st.size });
      } catch {
        return print({ exists: false });
      }
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

const WELCOME_MARKER = 'hosted with VEXPANEL';

/** A target folder must be missing, empty, or hold only the panel's own welcome page (which is removed). */
async function ensureEmptyTarget(target: string) {
  let entries: string[];
  try {
    entries = await fs.readdir(target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  if (entries.length === 0) return;
  if (entries.length === 1 && entries[0] === 'index.html') {
    const content = await fs.readFile(path.join(target, 'index.html'), 'utf8').catch(() => '');
    if (content.includes(WELCOME_MARKER)) {
      await fs.rm(path.join(target, 'index.html'));
      return;
    }
  }
  throw new UserFacing('That folder already has files in it. Choose an empty folder, or remove its contents first.');
}

function sh(cmd: string, argv: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, argv, { cwd, maxBuffer: 8 * 1024 * 1024, timeout: 10 * 60_000 }, (err, _out, errOut) => {
      if (err) reject(new UserFacing(`Couldn't unpack the package: ${String(errOut || err.message).trim().split('\n').slice(-2).join(' ')}`));
      else resolve();
    });
  });
}

async function unpack(archive: string, dest: string) {
  const fh = await fs.open(archive, 'r');
  const head = Buffer.alloc(8);
  await fh.read(head, 0, 8, 0);
  await fh.close();
  if (head[0] === 0x50 && head[1] === 0x4b) {
    await sh('unzip', ['-q', '-o', archive, '-d', dest], dest);
  } else {
    // GNU tar detects gzip, bzip2 and xz itself; the flags keep extracted files owned by us with sane modes.
    await sh('tar', ['-xf', archive, '-C', dest, '--no-same-owner', '--no-same-permissions'], dest);
  }
}

/** Find the folder inside an unpacked archive that holds the app. */
async function locateApp(stage: string, subdir?: string): Promise<string> {
  const top = await fs.readdir(stage, { withFileTypes: true });
  if (subdir) {
    const re = new RegExp('^' + subdir.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
    const hit = top.find((e) => e.isDirectory() && re.test(e.name));
    if (hit) return path.join(stage, hit.name);
  }
  const dirs = top.filter((e) => e.isDirectory());
  if (top.length === 1 && dirs.length === 1) return path.join(stage, dirs[0].name);
  // A single folder alongside only loose readme/licence files, e.g. Matomo's zip.
  if (dirs.length === 1 && top.every((e) => e.isDirectory() || !/\.php$/i.test(e.name))) return path.join(stage, dirs[0].name);
  return stage;
}

/** Folders 755 and files 644 so the web server can read them; symlinks are left alone. */
async function normalizeModes(dir: string) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      await fs.chmod(p, 0o755);
      await normalizeModes(p);
    } else {
      await fs.chmod(p, 0o644);
    }
  }
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
