import { spawn } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import path from 'node:path';
import { config } from '../config.js';
import { all, audit, exec, one, type DomainRow, type UserRow } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { dryLog, serial } from '../sys/exec.js';
import * as v from '../validate.js';
import { findApp, resolveDownload, type AppDef } from '../apps/catalog.js';
import { limitCheck } from './accounts.js';
import { fileOp } from './files.js';
import * as mysql from './mysql.js';
import { homeOf, previewUrl } from './web.js';

export interface AppInstallRow {
  id: number;
  user_id: number;
  app_id: string;
  version: string;
  path: string;
  url: string;
  status: 'installing' | 'ready' | 'failed' | 'removing';
  message: string;
  database_id: number | null;
  db_user_id: number | null;
  db_password: string;
  setup_url: string;
  admin_url: string;
  created_at: string;
}

/** Where an app can be installed: by domain, or by IP preview (the main web root). */
export interface Location {
  id: string;
  label: string;
  docroot: string;
  baseUrl: string;
}

export function locationsFor(user: UserRow): Location[] {
  const domains = all<DomainRow>('SELECT * FROM domains WHERE user_id = ? ORDER BY type, name', user.id);
  const out: Location[] = [];
  const main = domains.find((d) => d.type === 'main');
  if (main) out.push({ id: 'ip', label: `Server IP (no domain needed)`, docroot: main.docroot, baseUrl: previewUrl(user.username) });
  for (const d of domains) {
    out.push({ id: String(d.id), label: d.name, docroot: d.docroot, baseUrl: `${d.ssl ? 'https' : 'http'}://${d.name}/` });
  }
  return out;
}

const randomString = (len: number, alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789') =>
  Array.from({ length: len }, () => alphabet[randomInt(alphabet.length)]).join('');

/** Single-quoted YAML scalar. */
const yq = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** Single-quoted PHP string. */
const pq = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function renderWpConfig(db: { name: string; user: string; password: string }): string {
  const salt = () => randomString(64, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,-.:;<=>?@[]^_{|}~');
  const keys = ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT'];
  return `<?php
/* Written by the VEXPANEL app installer. */
define( 'DB_NAME', ${pq(db.name)} );
define( 'DB_USER', ${pq(db.user)} );
define( 'DB_PASSWORD', ${pq(db.password)} );
define( 'DB_HOST', 'localhost' );
define( 'DB_CHARSET', 'utf8mb4' );
define( 'DB_COLLATE', '' );

${keys.map((k) => `define( '${k}', ${pq(salt())} );`).join('\n')}

$table_prefix = 'wp_';

define( 'WP_DEBUG', false );
define( 'FS_METHOD', 'direct' );

if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', __DIR__ . '/' );
}
require_once ABSPATH . 'wp-settings.php';
`;
}

/** One-time WordPress setup script, run with PHP's CLI as the account user. Reads its settings from stdin. */
export const WP_SETUP_SCRIPT = `<?php
$in = json_decode(stream_get_contents(STDIN), true);
$u = parse_url($in['url']);
$_SERVER['HTTP_HOST'] = $u['host'] . (isset($u['port']) ? ':' . $u['port'] : '');
$_SERVER['SERVER_NAME'] = $u['host'];
$_SERVER['REQUEST_URI'] = isset($u['path']) ? $u['path'] : '/';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';
if ($u['scheme'] === 'https') { $_SERVER['HTTPS'] = 'on'; }
define('WP_INSTALLING', true);
require $in['dir'] . '/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
if (is_blog_installed()) { fwrite(STDERR, "WordPress is already installed in this database.\\n"); exit(1); }
$r = wp_install($in['title'], $in['user'], $in['email'], true, '', wp_slash($in['password']));
$url = rtrim($in['url'], '/');
update_option('siteurl', $url);
update_option('home', $url);
echo json_encode(array('ok' => true, 'user_id' => $r['user_id']));
`;

export function renderPhpbbConfig(o: {
  admin: { user: string; password: string; email: string };
  title: string;
  db: { name: string; user: string; password: string };
  url: string;
}): string {
  const u = new URL(o.url);
  const https = u.protocol === 'https:';
  const scriptPath = u.pathname.replace(/\/+$/, '') || '/';
  return `installer:
    admin:
        name: ${yq(o.admin.user)}
        password: ${yq(o.admin.password)}
        email: ${yq(o.admin.email)}
    board:
        lang: en
        name: ${yq(o.title)}
        description: ''
    database:
        dbms: mysqli
        dbhost: localhost
        dbport: ~
        dbuser: ${yq(o.db.user)}
        dbpasswd: ${yq(o.db.password)}
        dbname: ${yq(o.db.name)}
        table_prefix: phpbb_
    email:
        enabled: false
        smtp_delivery: ~
        smtp_host: ~
        smtp_port: ~
        smtp_auth: ~
        smtp_user: ~
        smtp_pass: ~
    server:
        cookie_secure: ${https}
        server_protocol: ${https ? 'https://' : 'http://'}
        force_server_vars: false
        server_name: ${yq(u.hostname)}
        server_port: ${u.port ? Number(u.port) : https ? 443 : 80}
        script_path: ${yq(scriptPath)}
`;
}

export function renderPhpMyAdminConfig(): string {
  return `<?php
/* Written by the VEXPANEL app installer. Sign in with a database user from the panel's Databases page. */
$cfg['blowfish_secret'] = ${pq(randomString(32))};
$i = 0;
$i++;
$cfg['Servers'][$i]['auth_type'] = 'cookie';
$cfg['Servers'][$i]['host'] = 'localhost';
$cfg['Servers'][$i]['compress'] = false;
$cfg['Servers'][$i]['AllowNoPassword'] = false;
$cfg['TempDir'] = __DIR__ . '/tmp';
$cfg['VersionCheck'] = false;
`;
}

/** Run a PHP script with the CLI as the account user. */
function runPhp(user: UserRow, argv: string[], cwdRel: string, stdin = ''): Promise<string> {
  if (config.dryRun) {
    dryLog(`$ (as ${user.username}) php ${argv.join(' ')}`);
    return Promise.resolve('{"ok":true}');
  }
  const home = homeOf(user.username);
  return new Promise((resolve, reject) => {
    const child = spawn(`php${config.phpVersion}`, ['-d', 'memory_limit=512M', '-d', 'max_execution_time=0', ...argv], {
      uid: user.uid!,
      gid: user.gid!,
      cwd: path.join(home, cwdRel),
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home },
      timeout: 10 * 60_000,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error(`Couldn't run PHP: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error((err || out).trim().split('\n').slice(-4).join(' ').slice(0, 600) || `PHP exited with code ${code}`));
    });
    child.stdin.end(stdin);
  });
}

function slugFor(app: AppDef): string {
  return app.id.replace(/[^a-z0-9]/g, '').slice(0, 8) || 'app';
}

/** Create a database plus a user with full rights on it, registered on the account. */
async function createAppDatabase(user: UserRow, app: AppDef) {
  limitCheck(user, 'db');
  const base = `${user.username}_${slugFor(app)}`;
  let name = base;
  for (let n = 2; one('SELECT id FROM databases WHERE name = ?', name) || one('SELECT id FROM db_users WHERE name = ?', name); n++) name = `${base}${n}`;
  if (name.length > 32) throw badRequest('Generated database name is too long.');
  const password = randomString(24);
  await serial(async () => {
    await mysql.createDatabase(name);
    await mysql.createUser(name, password);
    await mysql.grantAll(name, name);
  });
  const dbId = exec('INSERT INTO databases (user_id, name) VALUES (?, ?)', user.id, name).lastInsertRowid;
  const dbUserId = exec('INSERT INTO db_users (user_id, name) VALUES (?, ?)', user.id, name).lastInsertRowid;
  exec('INSERT INTO db_grants (database_id, db_user_id) VALUES (?, ?)', dbId, dbUserId);
  return { name, user: name, password, dbId, dbUserId };
}

async function dropAppDatabase(row: AppInstallRow) {
  const db = row.database_id ? one<{ id: number; name: string }>('SELECT * FROM databases WHERE id = ?', row.database_id) : undefined;
  const du = row.db_user_id ? one<{ id: number; name: string }>('SELECT * FROM db_users WHERE id = ?', row.db_user_id) : undefined;
  await serial(async () => {
    if (db) await mysql.dropDatabase(db.name);
    if (du) await mysql.dropUser(du.name);
  });
  if (db) exec('DELETE FROM databases WHERE id = ?', db.id);
  if (du) exec('DELETE FROM db_users WHERE id = ?', du.id);
}

export interface InstallInput {
  appId: unknown;
  location: unknown;
  folder: unknown;
  title?: unknown;
  adminUser?: unknown;
  adminPassword?: unknown;
  adminEmail?: unknown;
  archive?: unknown;
  createDatabase?: unknown;
}

/** Validate, record the install, and start it in the background. Returns the new install's id. */
export function startInstall(user: UserRow, input: InstallInput): number {
  const app = findApp(String(input.appId ?? ''));
  if (!app) throw notFound('Unknown app.');
  const loc = locationsFor(user).find((l) => l.id === String(input.location ?? ''));
  if (!loc) throw badRequest('Choose where to install it.');
  const folder = v.relPath(input.folder ?? '');
  if (folder && !/^[A-Za-z0-9._\-/]+$/.test(folder)) throw badRequest('Folder names may use letters, digits, dot, dash and underscore.');

  const home = homeOf(user.username);
  const absTarget = path.posix.join(loc.docroot, folder);
  const relTarget = path.posix.relative(home, absTarget);
  if (!relTarget || relTarget.startsWith('..')) throw badRequest('Invalid install location.');
  const url = loc.baseUrl + (folder ? `${folder.replace(/\/+$/, '')}/` : '');

  // Apps may nest (a blog at the root, a forum in /forum), but two can't share one folder.
  const clash = all<AppInstallRow>("SELECT * FROM app_installs WHERE user_id = ? AND status != 'failed'", user.id).find(
    (r) => r.path === relTarget,
  );
  if (clash) throw conflict(`Another app is already installed at ~/${clash.path}. Pick a different folder.`);

  let admin: { user: string; password: string; email: string } | undefined;
  let title = '';
  if (app.needsAdmin) {
    const au = String(input.adminUser ?? '').trim();
    if (!/^[A-Za-z0-9_.-]{3,30}$/.test(au)) throw badRequest('Admin username must be 3–30 letters, digits, dot, dash or underscore.');
    admin = { user: au, password: v.password(input.adminPassword), email: v.email(input.adminEmail) };
    title = String(input.title ?? '').trim().slice(0, 100) || app.name;
  }

  let archive = '';
  const wantsDb = app.source.type === 'upload' ? input.createDatabase !== false : app.database;
  if (app.source.type === 'upload') {
    archive = v.relPath(input.archive);
    if (!/\.(zip|tar\.gz|tgz|tar\.bz2|tar\.xz|tar)$/i.test(archive)) throw badRequest('Choose a .zip or .tar.gz file from your home folder.');
  }
  if (wantsDb) limitCheck(user, 'db');

  const id = exec(
    "INSERT INTO app_installs (user_id, app_id, path, url, status, message) VALUES (?, ?, ?, ?, 'installing', 'Starting…')",
    user.id, app.id, relTarget, url,
  ).lastInsertRowid;

  void runInstall(id, user, app, { relTarget, url, admin, title, archive, wantsDb });
  return id;
}

function progress(id: number, message: string) {
  exec('UPDATE app_installs SET message = ? WHERE id = ?', message, id);
}

async function runInstall(
  id: number,
  user: UserRow,
  app: AppDef,
  o: { relTarget: string; url: string; admin?: { user: string; password: string; email: string }; title: string; archive: string; wantsDb: boolean },
) {
  const pkgRel = `tmp/vex-pkg-${id}-${randomBytes(4).toString('hex')}`;
  let db: Awaited<ReturnType<typeof createAppDatabase>> | undefined;
  let unpacked = false;
  try {
    await fileOp(user, 'mkdir', { path: 'tmp', recursive: true });
    let archive = o.archive;
    if (app.source.type !== 'upload') {
      progress(id, 'Finding the latest version…');
      const { url, version } = await resolveDownload(app);
      exec('UPDATE app_installs SET version = ? WHERE id = ?', version, id);
      progress(id, `Downloading ${app.name} ${version === 'latest' ? '' : version}…`.replace('  ', ' '));
      await fileOp(user, 'fetch', { url, path: pkgRel });
      archive = pkgRel;
    }

    progress(id, 'Unpacking files…');
    await fileOp(user, 'extract', { archive, target: o.relTarget, subdir: app.subdir });
    unpacked = true;
    if (archive === pkgRel) await fileOp(user, 'rmtree', { path: pkgRel }).catch(() => undefined);

    if (o.wantsDb) {
      progress(id, 'Creating the database…');
      db = await createAppDatabase(user, app);
      exec('UPDATE app_installs SET database_id = ?, db_user_id = ?, db_password = ? WHERE id = ?', db.dbId, db.dbUserId, db.password, id);
    }

    const setupUrl = app.setup === 'wizard' ? o.url + (app.setupPath ?? '') : '';
    const adminUrl = app.adminPath ? o.url + app.adminPath : '';
    let message = '';

    if (app.id === 'wordpress' && db && o.admin) {
      progress(id, 'Setting up WordPress…');
      await fileOp(user, 'write', { path: `${o.relTarget}/wp-config.php` }, renderWpConfig(db));
      const script = `tmp/vex-wp-setup-${randomBytes(4).toString('hex')}.php`;
      await fileOp(user, 'write', { path: script }, WP_SETUP_SCRIPT);
      try {
        await runPhp(user, [path.posix.join(homeOf(user.username), script)], o.relTarget,
          JSON.stringify({ dir: path.posix.join(homeOf(user.username), o.relTarget), url: o.url, title: o.title, ...o.admin }));
      } finally {
        await fileOp(user, 'rmtree', { path: script }).catch(() => undefined);
      }
    } else if (app.id === 'phpbb' && db && o.admin) {
      progress(id, 'Setting up phpBB…');
      const cfg = `tmp/vex-phpbb-${randomBytes(4).toString('hex')}.yml`;
      await fileOp(user, 'write', { path: cfg }, renderPhpbbConfig({ admin: o.admin, title: o.title, db, url: o.url }));
      try {
        await runPhp(user, ['install/phpbbcli.php', 'install', path.posix.join(homeOf(user.username), cfg)], o.relTarget);
        await fileOp(user, 'rmtree', { path: `${o.relTarget}/install` });
      } catch (err) {
        // Leave the files and database in place so the web installer can finish the job.
        message = `Automatic setup didn't finish (${(err as Error).message}). Open the setup page to finish in your browser.`;
        exec('UPDATE app_installs SET setup_url = ? WHERE id = ?', `${o.url}install/`, id);
      } finally {
        await fileOp(user, 'rmtree', { path: cfg }).catch(() => undefined);
      }
    } else if (app.id === 'phpmyadmin') {
      await fileOp(user, 'write', { path: `${o.relTarget}/config.inc.php` }, renderPhpMyAdminConfig());
      await fileOp(user, 'mkdir', { path: `${o.relTarget}/tmp`, recursive: true });
    }

    exec(
      "UPDATE app_installs SET status = 'ready', message = ?, setup_url = CASE WHEN setup_url = '' THEN ? ELSE setup_url END, admin_url = ? WHERE id = ?",
      message, setupUrl, adminUrl, id,
    );
    audit(user.username, 'app.install', `${app.id} at ~/${o.relTarget}`);
  } catch (err) {
    const msg = (err as Error).message || 'Install failed.';
    exec("UPDATE app_installs SET status = 'failed', message = ? WHERE id = ?", msg.slice(0, 800), id);
    // Undo what we can: files that were unpacked and the database that was made.
    await fileOp(user, 'rmtree', { path: pkgRel }).catch(() => undefined);
    if (unpacked) {
      const isWebRoot = all<DomainRow>('SELECT * FROM domains WHERE user_id = ?', user.id).some(
        (d) => path.posix.relative(homeOf(user.username), d.docroot) === o.relTarget,
      );
      await fileOp(user, 'rmtree', { path: o.relTarget, contentsOnly: isWebRoot }).catch(() => undefined);
    }
    const row = one<AppInstallRow>('SELECT * FROM app_installs WHERE id = ?', id);
    if (row?.database_id || row?.db_user_id) await dropAppDatabase(row).catch(() => undefined);
    exec('UPDATE app_installs SET database_id = NULL, db_user_id = NULL WHERE id = ?', id);
    audit(user.username, 'app.install_failed', `${app.id}: ${msg.slice(0, 200)}`);
  }
}

/** Remove an installed app's files (and, if asked, the database the installer created). */
export async function removeInstall(user: UserRow, id: number, dropDb: boolean) {
  const row = one<AppInstallRow>('SELECT * FROM app_installs WHERE id = ? AND user_id = ?', id, user.id);
  if (!row) throw notFound();
  if (row.status === 'installing' || row.status === 'removing') throw conflict('Wait for the current install to finish.');
  if (row.status !== 'failed') {
    exec("UPDATE app_installs SET status = 'removing' WHERE id = ?", id);
    try {
      const isWebRoot = all<DomainRow>('SELECT * FROM domains WHERE user_id = ?', user.id).some(
        (d) => path.posix.relative(homeOf(user.username), d.docroot) === row.path,
      );
      // Leave alone any other app installed inside this one's folder.
      const keep = all<AppInstallRow>('SELECT * FROM app_installs WHERE user_id = ? AND id != ?', user.id, id)
        .filter((r) => r.path.startsWith(`${row.path}/`))
        .map((r) => r.path.slice(row.path.length + 1).split('/')[0]);
      const exists = await fileOp<{ exists: boolean }>(user, 'exists', { path: row.path });
      if (exists.exists) await fileOp(user, 'rmtree', { path: row.path, contentsOnly: isWebRoot || keep.length > 0, keep });
      if (dropDb) await dropAppDatabase(row);
    } catch (err) {
      exec("UPDATE app_installs SET status = 'ready' WHERE id = ?", id);
      throw err;
    }
  }
  exec('DELETE FROM app_installs WHERE id = ?', id);
  audit(user.username, 'app.remove', `${row.app_id} at ~/${row.path}`);
}

/** Installs interrupted by a panel restart can't resume; mark them failed. */
export function failInterruptedInstalls() {
  exec("UPDATE app_installs SET status = 'failed', message = 'Interrupted because the panel restarted. Remove it and try again.' WHERE status = 'installing'");
  exec("UPDATE app_installs SET status = 'ready' WHERE status = 'removing'");
}

export function listInstalls(userId: number) {
  return all<AppInstallRow & { db_name: string | null }>(
    `SELECT a.*, d.name AS db_name FROM app_installs a LEFT JOIN databases d ON d.id = a.database_id WHERE a.user_id = ? ORDER BY a.id DESC`,
    userId,
  );
}

