import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { all, exec, one, tx, type DomainRow, type PackageRow, type UserRow } from '../db.js';
import { badRequest, conflict, forbidden } from '../errors.js';
import { hashPassword, destroyUserSessions } from '../auth.js';
import { run, serial } from '../sys/exec.js';
import { ensureDir, removePath, writeAtomic } from '../sys/fsx.js';
import * as v from '../validate.js';
import { applyCron } from './cron.js';
import { applyZone, removeZone, seedZone } from './dns.js';
import { fileOp } from './files.js';
import { applyMail, removeMailboxDir } from './mail.js';
import * as mysql from './mysql.js';
import { deleteCertificate } from './ssl.js';
import { applyAccountWeb, fpmPoolPath, homeOf, reloadFpm, reloadNginx, removeVhost, renderFpmPool, writeIpSites, writeVhost } from './web.js';

const WELCOME_PAGE = (domain: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${domain}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0d1117;color:#e6edf3}
main{text-align:center}h1{font-weight:600;letter-spacing:-.02em}p{color:#8b949e}</style></head>
<body><main><h1>${domain}</h1><p>This site is hosted with VEXPANEL. Upload your files to <code>public_html</code>.</p></main></body></html>
`;

const PROTECTED_DIRS = new Set(['', 'logs', 'tmp', '.ssh', 'mail', '.config', '.cache']);

function pkgOf(u: UserRow): PackageRow {
  const p = one<PackageRow>('SELECT * FROM packages WHERE id = ?', u.package_id);
  if (!p) throw badRequest('Account has no hosting package.');
  return p;
}

export function count(table: string, userId: number, where = ''): number {
  return one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ? ${where}`, userId)!.n;
}

export function limitCheck(u: UserRow, what: 'addon' | 'sub' | 'db' | 'mail' | 'cron') {
  const p = pkgOf(u);
  const [used, max, label] = {
    addon: [count('domains', u.id, "AND type = 'addon'"), p.max_addon_domains, 'addon domains'],
    sub: [count('domains', u.id, "AND type = 'sub'"), p.max_subdomains, 'subdomains'],
    db: [count('databases', u.id), p.max_databases, 'databases'],
    mail: [count('mail_accounts', u.id), p.max_email_accounts, 'email accounts'],
    cron: [count('cron_jobs', u.id), p.max_cron_jobs, 'cron jobs'],
  }[what] as [number, number, string];
  if (used >= max) throw forbidden(`Your package allows ${max} ${label}. Ask your host to upgrade.`);
}

async function linuxUserExists(name: string): Promise<boolean> {
  const r = await run('getent', ['passwd', name], { allowFail: true, dryRunResult: { code: 2 } });
  return r.code === 0;
}

async function idOf(name: string): Promise<{ uid: number; gid: number }> {
  const u = await run('id', ['-u', name], { dryRunResult: { stdout: String(process.getuid?.() ?? 1000) } });
  const g = await run('id', ['-g', name], { dryRunResult: { stdout: String(process.getgid?.() ?? 1000) } });
  return { uid: Number(u.stdout.trim()), gid: Number(g.stdout.trim()) };
}

/** Create a directory inside the home dir as the user, then give it the web group with setgid so nginx can read it. */
async function makeWebRoot(user: UserRow, absDocroot: string) {
  const rel = path.posix.relative(homeOf(user.username), absDocroot);
  await fileOp(user, 'mkdir', { path: rel, recursive: true });
  if (config.dryRun) return;
  const st = await fs.lstat(absDocroot);
  if (!st.isDirectory() || st.isSymbolicLink()) throw badRequest('Document root must be a real directory.');
  await run('chown', ['-h', `${user.username}:www-data`, absDocroot]);
  await run('chmod', ['2750', absDocroot]);
}

async function setQuota(username: string, diskMb: number) {
  const kb = String(diskMb * 1024);
  // Quotas need the filesystem mounted with usrquota; if they aren't enabled this is a no-op.
  await run('setquota', ['-u', username, kb, kb, '0', '0', '-a'], { allowFail: true });
}

export interface CreateAccountInput {
  username: unknown;
  password: unknown;
  email: unknown;
  domain: unknown;
  packageId: unknown;
}

export function createAccount(input: CreateAccountInput): Promise<UserRow> {
  const username = v.username(input.username);
  const pw = v.password(input.password);
  const email = v.email(input.email);
  const domain = v.domain(input.domain);
  const packageId = Number(input.packageId);
  const pkg = one<PackageRow>('SELECT * FROM packages WHERE id = ?', packageId);
  if (!pkg) throw badRequest('Choose a hosting package.');
  if (one('SELECT id FROM users WHERE username = ?', username)) throw conflict(`Account "${username}" already exists.`);
  if (one('SELECT id FROM domains WHERE name = ?', domain)) throw conflict(`Domain ${domain} is already hosted here.`);

  return serial(async () => {
    if (await linuxUserExists(username)) throw conflict(`A system user named "${username}" already exists on this server.`);
    const home = homeOf(username);
    let created = false;
    try {
      await run('useradd', ['--create-home', '--home-dir', home, '--shell', '/usr/sbin/nologin', '--user-group', '--groups', 'vexusers', username]);
      created = true;
      await run('chpasswd', [], { input: `${username}:${pw}\n` });
      if (config.dryRun) await ensureDir(home, 0o711);
      const ids = await idOf(username);
      await run('chmod', ['711', home]);

      const passwordHash = await hashPassword(pw);
      const user = tx(() => {
        const { lastInsertRowid } = exec(
          "INSERT INTO users (username, password_hash, role, email, package_id, uid, gid) VALUES (?, ?, 'user', ?, ?, ?, ?)",
          username, passwordHash, email, pkg.id, ids.uid, ids.gid,
        );
        const d = exec("INSERT INTO domains (user_id, name, type, docroot) VALUES (?, ?, 'main', ?)", lastInsertRowid, domain, `${home}/public_html`);
        seedZone(d.lastInsertRowid);
        return one<UserRow>('SELECT * FROM users WHERE id = ?', lastInsertRowid)!;
      });

      for (const dir of ['logs', 'tmp']) await fileOp(user, 'mkdir', { path: dir, recursive: true });
      await fileOp(user, 'chmod', { path: 'tmp', mode: '700' });
      await makeWebRoot(user, `${home}/public_html`);
      await fileOp(user, 'write', { path: 'public_html/index.html' }, WELCOME_PAGE(domain));
      await setQuota(username, pkg.disk_mb);

      await writeAtomic(fpmPoolPath(username), renderFpmPool(username));
      await reloadFpm();
      const main = one<DomainRow>("SELECT * FROM domains WHERE user_id = ? AND type = 'main'", user.id)!;
      await writeVhost(main, user);
      await writeIpSites();
      await reloadNginx();
      await applyZone(main.id);
      await applyMail();
      return user;
    } catch (err) {
      // Best-effort cleanup so a half-created account doesn't linger.
      const row = one<UserRow>('SELECT * FROM users WHERE username = ?', username);
      if (row) await terminateAccount(row.id).catch(() => undefined);
      else if (created) await run('userdel', ['--remove', username], { allowFail: true });
      throw err;
    }
  });
}

export function setSuspended(userId: number, suspended: boolean): Promise<void> {
  return serial(async () => {
    const u = one<UserRow>("SELECT * FROM users WHERE id = ? AND role = 'user'", userId);
    if (!u) throw badRequest('No such account.');
    exec('UPDATE users SET status = ? WHERE id = ?', suspended ? 'suspended' : 'active', userId);
    await run('usermod', [suspended ? '--lock' : '--unlock', u.username]);
    if (suspended) {
      await run('pkill', ['-KILL', '-u', u.username], { allowFail: true });
      destroyUserSessions(userId);
    }
    await applyAccountWeb(userId);
    await applyMail();
    await applyCron(userId);
    const dbUsers = all<{ name: string }>('SELECT name FROM db_users WHERE user_id = ?', userId).map((r) => r.name);
    await mysql.setUsersLocked(dbUsers, suspended);
  });
}

/** Remove an account and everything it owns. Continues past individual failures and reports them. */
export function terminateAccount(userId: number): Promise<string[]> {
  return serial(async () => {
    const u = one<UserRow>("SELECT * FROM users WHERE id = ? AND role = 'user'", userId);
    if (!u) throw badRequest('No such account.');
    const problems: string[] = [];
    const attempt = async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        problems.push(`${label}: ${(e as Error).message}`);
      }
    };

    const domains = all<DomainRow>('SELECT * FROM domains WHERE user_id = ?', userId);
    const dbs = all<{ name: string }>('SELECT name FROM databases WHERE user_id = ?', userId);
    const dbUsers = all<{ name: string }>('SELECT name FROM db_users WHERE user_id = ?', userId);

    for (const d of dbs) await attempt(`drop database ${d.name}`, () => mysql.dropDatabase(d.name));
    for (const d of dbUsers) await attempt(`drop db user ${d.name}`, () => mysql.dropUser(d.name));
    await attempt('crontab', () => run('crontab', ['-r', '-u', u.username], { allowFail: true }));
    await attempt('processes', () => run('pkill', ['-KILL', '-u', u.username], { allowFail: true }));

    destroyUserSessions(userId);
    exec('DELETE FROM users WHERE id = ?', userId); // cascades to domains, records, mail, dbs, cron

    for (const d of domains) {
      await attempt(`vhost ${d.name}`, () => removeVhost(d.name));
      if (d.ssl) await attempt(`certificate ${d.name}`, () => deleteCertificate(d.name));
      if (d.type !== 'sub') {
        await attempt(`zone ${d.name}`, () => removeZone(d.name));
        await attempt(`mail ${d.name}`, () => removeMailboxDir(d.name));
      }
    }
    await attempt('php-fpm pool', () => removePath(fpmPoolPath(u.username)));
    await attempt('reload php-fpm', reloadFpm);
    await attempt('ip preview', writeIpSites);
    await attempt('reload nginx', reloadNginx);
    await attempt('mail maps', applyMail);
    await attempt('linux user', () => run('userdel', ['--remove', u.username], { allowFail: true }));
    if (config.dryRun) await attempt('home', () => removePath(homeOf(u.username)));
    return problems;
  });
}

export async function changePackage(userId: number, packageId: number) {
  const u = one<UserRow>("SELECT * FROM users WHERE id = ? AND role = 'user'", userId);
  const p = one<PackageRow>('SELECT * FROM packages WHERE id = ?', packageId);
  if (!u || !p) throw badRequest('Unknown account or package.');
  exec('UPDATE users SET package_id = ? WHERE id = ?', p.id, u.id);
  await setQuota(u.username, p.disk_mb);
}

export async function setAccountPassword(userId: number, pw: string) {
  const u = one<UserRow>('SELECT * FROM users WHERE id = ?', userId)!;
  exec('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(pw), userId);
  if (u.role === 'user') await run('chpasswd', [], { input: `${u.username}:${pw}\n` });
}

// ---------- Domains ----------

function docrootFor(user: UserRow, rel: unknown, fallback: string): string {
  const r = rel === undefined || rel === '' ? fallback : v.relPath(rel);
  if (PROTECTED_DIRS.has(r.split('/')[0])) throw badRequest('Choose a different document root.');
  return path.posix.join(homeOf(user.username), r);
}

export function addDomain(user: UserRow, input: { type: unknown; domain?: unknown; label?: unknown; parentId?: unknown; docroot?: unknown }) {
  const type = input.type === 'sub' ? 'sub' : input.type === 'addon' ? 'addon' : null;
  if (!type) throw badRequest('Type must be "addon" or "sub".');
  limitCheck(user, type);

  let name: string;
  let parent: DomainRow | undefined;
  if (type === 'addon') {
    name = v.domain(input.domain);
  } else {
    parent = one<DomainRow>("SELECT * FROM domains WHERE id = ? AND user_id = ? AND type IN ('main','addon')", Number(input.parentId), user.id);
    if (!parent) throw badRequest('Choose the domain this subdomain belongs to.');
    name = `${v.subLabel(input.label)}.${parent.name}`;
  }
  if (one('SELECT id FROM domains WHERE name = ?', name)) throw conflict(`${name} is already hosted here.`);
  const docroot = docrootFor(user, input.docroot, type === 'addon' ? name : `public_html/${name.split('.')[0]}`);

  return serial(async () => {
    await makeWebRoot(user, docroot);
    const id = tx(() => {
      const r = exec('INSERT INTO domains (user_id, name, type, parent_id, docroot) VALUES (?, ?, ?, ?, ?)', user.id, name, type, parent?.id ?? null, docroot);
      if (type === 'addon') seedZone(r.lastInsertRowid);
      else exec("INSERT INTO dns_records (domain_id, name, type, value, ttl) VALUES (?, ?, 'A', ?, 3600)", parent!.id, name.split('.')[0], config.serverIp);
      return r.lastInsertRowid;
    });
    try {
      const d = one<DomainRow>('SELECT * FROM domains WHERE id = ?', id)!;
      await writeVhost(d, user);
      await reloadNginx();
      await applyZone(type === 'addon' ? id : parent!.id);
      if (type === 'addon') await applyMail();
      return d;
    } catch (err) {
      await removeDomain(user, id).catch(() => undefined);
      throw err;
    }
  });
}

export function removeDomain(user: UserRow, domainId: number) {
  const d = one<DomainRow>('SELECT * FROM domains WHERE id = ? AND user_id = ?', domainId, user.id);
  if (!d) throw badRequest('No such domain.');
  if (d.type === 'main') throw badRequest('The main domain can only be removed by terminating the account.');
  return serial(async () => {
    const subs = all<DomainRow>('SELECT * FROM domains WHERE parent_id = ?', d.id);
    tx(() => {
      if (d.type === 'sub') exec("DELETE FROM dns_records WHERE domain_id = ? AND name = ? AND type IN ('A','AAAA','CNAME')", d.parent_id, d.name.split('.')[0]);
      exec('DELETE FROM domains WHERE id = ?', d.id);
    });
    for (const x of [d, ...subs]) {
      await removeVhost(x.name);
      if (x.ssl) await deleteCertificate(x.name);
    }
    await reloadNginx();
    if (d.type === 'sub') await applyZone(d.parent_id!);
    else {
      await removeZone(d.name);
      await applyMail();
      await removeMailboxDir(d.name);
    }
  });
}

/** Recalculate disk usage for one account (runs as the account user). */
export async function refreshDiskUsage(user: UserRow): Promise<number> {
  const r = await fileOp<{ bytes: number }>(user, 'du', {});
  exec("UPDATE users SET disk_used_bytes = ?, disk_checked_at = datetime('now') WHERE id = ?", r.bytes, user.id);
  return r.bytes;
}

