import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'vexpanel-apps-'));
const pkgDir = mkdtempSync(path.join(tmpdir(), 'vexpanel-pkgs-'));

// Build two small archives shaped like the real packages.
mkdirSync(path.join(pkgDir, 'src/wordpress/wp-admin'), { recursive: true });
writeFileSync(path.join(pkgDir, 'src/wordpress/index.php'), '<?php // wp');
writeFileSync(path.join(pkgDir, 'src/wordpress/wp-admin/install.php'), '<?php');
execFileSync('tar', ['-czf', path.join(pkgDir, 'wordpress.tar.gz'), '-C', path.join(pkgDir, 'src'), 'wordpress']);
mkdirSync(path.join(pkgDir, 'src2/dokuwiki-2026-01-01'), { recursive: true });
writeFileSync(path.join(pkgDir, 'src2/dokuwiki-2026-01-01/doku.php'), '<?php');
execFileSync('tar', ['-czf', path.join(pkgDir, 'dokuwiki.tgz'), '-C', path.join(pkgDir, 'src2'), 'dokuwiki-2026-01-01']);

let server: Server;
let port = 0;
await new Promise<void>((resolve) => {
  server = createServer((req, res) => {
    const f = path.join(pkgDir, path.basename(req.url ?? ''));
    if (!existsSync(f)) return void res.writeHead(404).end('nope');
    res.writeHead(200).end(readFileSync(f));
  }).listen(0, '127.0.0.1', () => {
    port = (server.address() as { port: number }).port;
    resolve();
  });
});

writeFileSync(
  path.join(dataDir, 'apps.json'),
  JSON.stringify({
    wordpress: { source: { type: 'url', url: `http://127.0.0.1:${port}/wordpress.tar.gz` } },
    dokuwiki: { source: { type: 'url', url: `http://127.0.0.1:${port}/dokuwiki.tgz` } },
    joomla: { source: { type: 'url', url: `http://127.0.0.1:${port}/missing.zip` } },
  }),
);

process.env.VEX_DATA_DIR = dataDir;
process.env.VEX_DRY_RUN = '1';
process.env.VEX_SECURE_COOKIES = '0';
process.env.VEX_SERVER_IP = '203.0.113.10';
process.env.VEX_LOG_LEVEL = 'silent';
process.env.VEX_APPS_FILE = path.join(dataDir, 'apps.json');

const { buildApp } = await import('../src/server/index.ts');
const { exec, one } = await import('../src/server/db.ts');
const { hashPassword } = await import('../src/server/auth.ts');
let app: Awaited<ReturnType<typeof buildApp>>;
const dry = (p: string) => path.join(dataDir, 'dryroot', p);

function client() {
  const jar = new Map<string, string>();
  return async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      payload: payload as object,
      headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), 'x-csrf-token': jar.get('vex_csrf') ?? '' },
    });
    for (const c of res.cookies) jar.set(c.name, c.value);
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
}

async function waitFor(call: ReturnType<typeof client>, id: number) {
  for (let i = 0; i < 100; i++) {
    const r = await call('GET', '/api/apps');
    const row = r.body.installs.find((x: { id: number }) => x.id === id);
    if (row && row.status !== 'installing') return row;
    await new Promise((res) => setTimeout(res, 50));
  }
  const r = await call("GET", "/api/apps");
  throw new Error("install did not finish: " + id + " " + JSON.stringify(r.body).slice(0, 600));
}

before(async () => {
  exec("INSERT INTO users (username, password_hash, role, email) VALUES ('admin', ?, 'admin', 'a@b.test')", await hashPassword('admin-password-123'));
  app = await buildApp();
});

after(async () => {
  await app.close();
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(pkgDir, { recursive: true, force: true });
});

test('IP preview and app installer lifecycle (dry run)', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin-password-123' });
  const pkgs = (await admin('GET', '/api/admin/packages')).body;
  const starter = pkgs.find((p: { name: string }) => p.name === 'Starter'); // 2 databases
  const created = await admin('POST', '/api/admin/accounts', { username: 'bob', password: 'bob-password-1', email: 'b@b.test', domain: 'bob.test', packageId: starter.id });
  assert.equal(created.status, 200, JSON.stringify(created.body));

  // IP preview server and symlink map.
  const ipConf = readFileSync(dry('/etc/nginx/vexpanel/000-ip-preview.conf'), 'utf8');
  assert.match(ipConf, /listen 80 default_server;/);
  assert.match(ipConf, /location \^~ \/~bob\/ \{/);
  assert.match(ipConf, /fastcgi_pass unix:\/run\/php\/vex-bob\.sock;/);
  assert.equal(readlinkSync(path.join(dataDir, 'ipsites', '~bob')), '/home/bob/public_html');

  const bob = client();
  await bob('POST', '/api/auth/login', { username: 'bob', password: 'bob-password-1' });
  const overview = await bob('GET', '/api/user/overview');
  assert.equal(overview.body.previewUrl, 'http://203.0.113.10/~bob/');

  const apps = await bob('GET', '/api/apps');
  assert.ok(apps.body.catalog.some((a: { id: string }) => a.id === 'phpbb'));
  assert.ok(apps.body.catalog.find((a: { id: string }) => a.id === 'custom').upload);
  assert.deepEqual(apps.body.locations.map((l: { id: string }) => l.id).slice(0, 1), ['ip']);

  // WordPress into the web root by IP: replaces the welcome page, creates a database, writes wp-config.
  const wp = await bob('POST', '/api/apps/install', {
    appId: 'wordpress', location: 'ip', folder: '', title: 'Bob', adminUser: 'bob', adminPassword: 'wp-admin-pass-1', adminEmail: 'b@b.test',
  });
  assert.equal(wp.status, 200, JSON.stringify(wp.body));
  const wpRow = await waitFor(bob, wp.body.id);
  assert.equal(wpRow.status, 'ready', wpRow.message);
  assert.equal(wpRow.url, 'http://203.0.113.10/~bob/');
  assert.equal(wpRow.adminUrl, 'http://203.0.113.10/~bob/wp-admin/');
  assert.equal(wpRow.database.name, 'bob_wordpres');
  assert.ok(existsSync(dry('/home/bob/public_html/wp-admin/install.php')));
  assert.ok(!existsSync(dry('/home/bob/public_html/index.html')), 'welcome page replaced');
  const wpConfig = readFileSync(dry('/home/bob/public_html/wp-config.php'), 'utf8');
  assert.match(wpConfig, /define\( 'DB_NAME', 'bob_wordpres' \);/);
  assert.match(readFileSync(path.join(dataDir, 'dryrun.log'), 'utf8'), /CREATE DATABASE `bob_wordpres`/);
  assert.ok(!existsSync(dry('/home/bob/tmp')) || !execFileSync('ls', [dry('/home/bob/tmp')]).toString().includes('vex-'), 'temp files cleaned');

  // Same folder again is refused.
  assert.equal((await bob('POST', '/api/apps/install', { appId: 'dokuwiki', location: 'ip', folder: '' })).status, 409);

  // DokuWiki into a subfolder: no database, setup page points at install.php.
  const dw = await bob('POST', '/api/apps/install', { appId: 'dokuwiki', location: 'ip', folder: 'wiki' });
  assert.equal(dw.status, 200, JSON.stringify(dw.body));
  const dwRow = await waitFor(bob, dw.body.id);
  assert.equal(dwRow.status, 'ready', dwRow.message);
  assert.equal(dwRow.setupUrl, 'http://203.0.113.10/~bob/wiki/install.php');
  assert.equal(dwRow.database, null);
  assert.ok(existsSync(dry('/home/bob/public_html/wiki/doku.php')), 'subdir stripped');

  // A failed download leaves nothing behind and doesn't use a database slot.
  const bad = await bob('POST', '/api/apps/install', { appId: 'joomla', location: 'ip', folder: 'cms' });
  const badRow = await waitFor(bob, bad.body.id);
  assert.equal(badRow.status, 'failed');
  assert.match(badRow.message, /404/);
  assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM databases WHERE name LIKE 'bob_%'")!.n, 1);
  assert.equal((await bob('POST', `/api/apps/${bad.body.id}/remove`, {})).status, 200);

  // Package limit: Starter allows 2 databases; WordPress used one.
  const wp2 = await bob('POST', '/api/apps/install', {
    appId: 'wordpress', location: 'ip', folder: 'blog2', adminUser: 'bob', adminPassword: 'wp-admin-pass-1', adminEmail: 'b@b.test',
  });
  assert.equal((await waitFor(bob, wp2.body.id)).status, 'ready');
  const wp3 = await bob('POST', '/api/apps/install', {
    appId: 'wordpress', location: 'ip', folder: 'blog3', adminUser: 'bob', adminPassword: 'wp-admin-pass-1', adminEmail: 'b@b.test',
  });
  assert.equal(wp3.status, 403);

  // Bad input is rejected.
  assert.equal((await bob('POST', '/api/apps/install', { appId: 'wordpress', location: 'ip', folder: '../x', adminUser: 'bob', adminPassword: 'wp-admin-pass-1', adminEmail: 'b@b.test' })).status, 400);
  assert.equal((await bob('POST', '/api/apps/install', { appId: 'nope', location: 'ip', folder: 'x' })).status, 404);
  assert.equal((await bob('POST', '/api/apps/install', { appId: 'custom', location: 'ip', folder: 'vb', archive: 'notes.txt' })).status, 400);

  // Remove WordPress from the web root: contents go, the folder stays, the database is dropped.
  assert.equal((await bob('POST', `/api/apps/${wp.body.id}/remove`, { dropDatabase: true })).status, 200);
  assert.ok(existsSync(dry('/home/bob/public_html')));
  assert.ok(!existsSync(dry('/home/bob/public_html/wp-config.php')));
  assert.ok(existsSync(dry('/home/bob/public_html/wiki/doku.php')), 'nested app kept');
  assert.ok(existsSync(dry('/home/bob/public_html/blog2/index.php')), 'nested app kept');
  assert.equal(one("SELECT id FROM databases WHERE name = 'bob_wordpres'"), undefined);

  // Suspending swaps the IP preview to the suspended page; terminating removes it.
  const bobId = one<{ id: number }>("SELECT id FROM users WHERE username = 'bob'")!.id;
  await admin('POST', `/api/admin/accounts/${bobId}/suspend`);
  assert.doesNotMatch(readFileSync(dry('/etc/nginx/vexpanel/000-ip-preview.conf'), 'utf8'), /vex-bob\.sock/);
  await admin('DELETE', `/api/admin/accounts/${bobId}`, { confirm: 'bob' });
  assert.doesNotMatch(readFileSync(dry('/etc/nginx/vexpanel/000-ip-preview.conf'), 'utf8'), /~bob/);
  assert.ok(!existsSync(path.join(dataDir, 'ipsites', '~bob')));
});
