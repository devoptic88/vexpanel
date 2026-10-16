import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'vexpanel-test-'));
process.env.VEX_DATA_DIR = dataDir;
process.env.VEX_DRY_RUN = '1';
process.env.VEX_SECURE_COOKIES = '0';
process.env.VEX_ADMIN_PASSWORD = 'admin-password-123';
process.env.VEX_SERVER_IP = '203.0.113.10';
process.env.VEX_NAMESERVERS = 'ns1.vexhost.test,ns2.vexhost.test';
process.env.VEX_LOG_LEVEL = 'silent';

const { buildApp } = await import('../src/server/index.ts');
const { exec, one } = await import('../src/server/db.ts');
const { hashPassword } = await import('../src/server/auth.ts');
type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;

const dry = (p: string) => path.join(dataDir, 'dryroot', p);

/** Minimal cookie-jar client around app.inject. */
function client() {
  const jar = new Map<string, string>();
  async function call(method: string, url: string, payload?: unknown, extra: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: method as 'GET',
      url,
      payload: payload as object,
      headers: {
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        'x-csrf-token': jar.get('vex_csrf') ?? '',
        ...(extra.headers as object),
      },
    });
    for (const c of res.cookies) {
      if (c.value === '' || (c as { maxAge?: number }).maxAge === 0) jar.delete(c.name);
      else jar.set(c.name, c.value);
    }
    const body = res.body ? JSON.parse(res.body) : null;
    return { status: res.statusCode, body };
  }
  return { call, jar };
}

before(async () => {
  exec("INSERT INTO users (username, password_hash, role, email) VALUES ('admin', ?, 'admin', 'admin@vexhost.test')", await hashPassword('admin-password-123'));
  app = await buildApp();
});

after(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('full account lifecycle in dry-run mode', async () => {
  const admin = client();
  assert.equal((await admin.call('POST', '/api/auth/login', { username: 'admin', password: 'wrong' })).status, 401);
  const login = await admin.call('POST', '/api/auth/login', { username: 'admin', password: 'admin-password-123' });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, 'admin');

  // CSRF is enforced.
  const noCsrf = await app.inject({ method: 'POST', url: '/api/admin/packages', payload: {}, headers: { cookie: `vex_session=${admin.jar.get('vex_session')}` } });
  assert.equal(noCsrf.statusCode, 403);

  const pkgs = await admin.call('GET', '/api/admin/packages');
  const business = pkgs.body.find((p: { name: string }) => p.name === 'Business');

  const created = await admin.call('POST', '/api/admin/accounts', {
    username: 'acme', password: 'acme-password-1', email: 'owner@acme.test', domain: 'acme.test', packageId: business.id,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal((await admin.call('POST', '/api/admin/accounts', { username: 'acme', password: 'x'.repeat(12), email: 'a@b.test', domain: 'other.test', packageId: business.id })).status, 409);

  // System config was rendered.
  const vhost = readFileSync(dry('/etc/nginx/vexpanel/acme.test.conf'), 'utf8');
  assert.match(vhost, /server_name acme\.test www\.acme\.test;/);
  assert.match(vhost, /fastcgi_pass unix:\/run\/php\/vex-acme\.sock;/);
  assert.ok(existsSync(dry('/etc/php/8.3/fpm/pool.d/vex-acme.conf')));
  const zone = readFileSync(dry('/etc/bind/vexpanel/db.acme.test'), 'utf8');
  assert.match(zone, /@ 3600 IN A 203\.0\.113\.10/);
  assert.match(zone, /@ 86400 IN NS ns1\.vexhost\.test\./);
  assert.ok(existsSync(dry('/home/acme/public_html/index.html')));

  // Log in as the account.
  const acme = client();
  assert.equal((await acme.call('POST', '/api/auth/login', { username: 'acme', password: 'acme-password-1' })).status, 200);
  assert.equal((await acme.call('GET', '/api/admin/accounts')).status, 403);
  const overview = await acme.call('GET', '/api/user/overview');
  assert.equal(overview.body.domain, 'acme.test');

  // Domains
  const addon = await acme.call('POST', '/api/domains', { type: 'addon', domain: 'acme-shop.test' });
  assert.equal(addon.status, 200, JSON.stringify(addon.body));
  const main = one<{ id: number }>("SELECT id FROM domains WHERE name = 'acme.test'")!;
  const sub = await acme.call('POST', '/api/domains', { type: 'sub', label: 'blog', parentId: main.id });
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  assert.match(readFileSync(dry('/etc/bind/vexpanel/db.acme.test'), 'utf8'), /blog 3600 IN A 203\.0\.113\.10/);
  assert.ok(existsSync(dry('/etc/nginx/vexpanel/blog.acme.test.conf')));
  assert.equal((await acme.call('POST', '/api/domains', { type: 'sub', label: 'blog', parentId: main.id })).status, 409);
  assert.equal((await acme.call('POST', '/api/domains', { type: 'addon', domain: 'acme.test' })).status, 409);

  // Files
  assert.equal((await acme.call('POST', '/api/files/write', { path: 'public_html/hello.php', content: '<?php echo "hi";' })).status, 200);
  const list = await acme.call('GET', '/api/files/list?path=public_html');
  assert.ok(list.body.some((f: { name: string }) => f.name === 'hello.php'));
  assert.equal((await acme.call('GET', '/api/files/read?path=public_html/hello.php')).body.content, '<?php echo "hi";');
  assert.equal((await acme.call('GET', '/api/files/read?path=../../etc/passwd')).status, 400);
  assert.equal((await acme.call('POST', '/api/files/rename', { from: 'public_html/hello.php', to: 'public_html/index.php' })).status, 200);
  assert.equal((await acme.call('POST', '/api/files/mkdir', { path: 'public_html/assets' })).status, 200);
  assert.equal((await acme.call('POST', '/api/files/chmod', { path: 'public_html/index.php', mode: '600' })).status, 200);
  assert.equal((await acme.call('POST', '/api/files/delete', { paths: ['public_html/assets'] })).status, 200);
  assert.equal((await acme.call('POST', '/api/files/delete', { paths: [''] })).status, 400);

  // Databases
  assert.equal((await acme.call('POST', '/api/databases', { name: 'wp' })).status, 200);
  assert.equal((await acme.call('POST', '/api/databases/users', { name: 'wpuser', password: 'db-password-123' })).status, 200);
  const dbs = await acme.call('GET', '/api/databases');
  assert.equal(dbs.body.databases[0].name, 'acme_wp');
  assert.equal((await acme.call('POST', '/api/databases/grants', { databaseId: dbs.body.databases[0].id, userId: dbs.body.users[0].id })).status, 200);
  assert.equal((await acme.call('POST', '/api/databases', { name: 'bad-name' })).status, 400);
  assert.match(readFileSync(path.join(dataDir, 'dryrun.log'), 'utf8'), /GRANT ALL PRIVILEGES ON `acme_wp`\.\* TO 'acme_wpuser'@'localhost'/);
  assert.doesNotMatch(readFileSync(path.join(dataDir, 'dryrun.log'), 'utf8'), /db-password-123/);

  // Email
  const mailCreate = await acme.call('POST', '/api/email/accounts', { domainId: main.id, local: 'hello', password: 'mail-password-1', quotaMb: 500 });
  assert.equal(mailCreate.status, 200, JSON.stringify(mailCreate.body));
  assert.equal((await acme.call('POST', '/api/email/forwarders', { domainId: main.id, local: 'sales', destination: 'boss@example.org' })).status, 200);
  assert.match(readFileSync(dry('/etc/postfix/vexpanel/vmailbox'), 'utf8'), /hello@acme\.test acme\.test\/hello\//);
  assert.match(readFileSync(dry('/etc/postfix/vexpanel/valias'), 'utf8'), /sales@acme\.test boss@example\.org/);
  assert.match(readFileSync(dry('/etc/dovecot/vexpanel-users'), 'utf8'), /hello@acme\.test:\{SSHA512\}/);
  assert.match(readFileSync(dry('/etc/postfix/vexpanel/vdomains'), 'utf8'), /acme-shop\.test OK/);

  // DNS
  const rec = await acme.call('POST', `/api/dns/${main.id}/records`, { name: 'api', type: 'CNAME', value: 'acme.test.' });
  assert.equal(rec.status, 200, JSON.stringify(rec.body));
  assert.equal((await acme.call('POST', `/api/dns/${main.id}/records`, { name: 'api', type: 'A', value: '1.2.3.4' })).status, 409);
  assert.equal((await acme.call('POST', `/api/dns/${main.id}/records`, { name: 'x', type: 'A', value: '999.1.1.1' })).status, 400);
  assert.match(readFileSync(dry('/etc/bind/vexpanel/db.acme.test'), 'utf8'), /api 3600 IN CNAME acme\.test\./);
  assert.match(readFileSync(dry('/etc/bind/named.conf.vexpanel'), 'utf8'), /zone "acme-shop\.test"/);

  // SSL
  const ssl = await acme.call('POST', `/api/ssl/${main.id}/issue`, {});
  assert.equal(ssl.status, 200, JSON.stringify(ssl.body));
  assert.match(readFileSync(dry('/etc/nginx/vexpanel/acme.test.conf'), 'utf8'), /listen 443 ssl http2;/);

  // Cron
  assert.equal((await acme.call('POST', '/api/cron', { schedule: '*/5 * * * *', command: 'php ~/public_html/cron.php' })).status, 200);
  assert.equal((await acme.call('POST', '/api/cron', { schedule: 'every minute', command: 'x' })).status, 400);

  // Another account can't touch acme's domain.
  await admin.call('POST', '/api/admin/accounts', { username: 'other', password: 'other-password', email: 'o@o.test', domain: 'other.test', packageId: business.id });
  const other = client();
  await other.call('POST', '/api/auth/login', { username: 'other', password: 'other-password' });
  assert.equal((await other.call('GET', `/api/dns/${main.id}`)).status, 404);
  assert.equal((await other.call('POST', `/api/ssl/${main.id}/issue`, {})).status, 404);

  // Suspend: sessions killed, login refused, vhost serves suspended page.
  const acmeId = one<{ id: number }>("SELECT id FROM users WHERE username = 'acme'")!.id;
  assert.equal((await admin.call('POST', `/api/admin/accounts/${acmeId}/suspend`)).status, 200);
  assert.equal((await acme.call('GET', '/api/user/overview')).status, 401);
  assert.equal((await acme.call('POST', '/api/auth/login', { username: 'acme', password: 'acme-password-1' })).status, 423);
  assert.doesNotMatch(readFileSync(dry('/etc/nginx/vexpanel/acme.test.conf'), 'utf8'), /fastcgi_pass/);
  assert.ok(!existsSync(dry('/etc/php/8.3/fpm/pool.d/vex-acme.conf')));
  assert.match(readFileSync(dry('/etc/dovecot/vexpanel-users'), 'utf8'), /hello@acme\.test:!:/);
  assert.equal((await admin.call('POST', `/api/admin/accounts/${acmeId}/unsuspend`)).status, 200);
  assert.match(readFileSync(dry('/etc/nginx/vexpanel/acme.test.conf'), 'utf8'), /fastcgi_pass/);

  // Log in as, then return to admin.
  assert.equal((await admin.call('POST', `/api/admin/accounts/${acmeId}/login-as`)).status, 200);
  const me = await admin.call('GET', '/api/auth/me');
  assert.equal(me.body.user.username, 'acme');
  assert.equal(me.body.impersonatedBy, 'admin');
  assert.equal((await admin.call('POST', '/api/auth/return')).status, 200);
  assert.equal((await admin.call('GET', '/api/auth/me')).body.user.username, 'admin');

  // Terminate requires typing the username, then removes everything.
  assert.equal((await admin.call('DELETE', `/api/admin/accounts/${acmeId}`, { confirm: 'nope' })).status, 400);
  const term = await admin.call('DELETE', `/api/admin/accounts/${acmeId}`, { confirm: 'acme' });
  assert.equal(term.status, 200, JSON.stringify(term.body));
  assert.deepEqual(term.body.problems, []);
  assert.ok(!existsSync(dry('/etc/nginx/vexpanel/acme.test.conf')));
  assert.ok(!existsSync(dry('/etc/nginx/vexpanel/blog.acme.test.conf')));
  assert.ok(!existsSync(dry('/etc/bind/vexpanel/db.acme.test')));
  assert.doesNotMatch(readFileSync(dry('/etc/postfix/vexpanel/vdomains'), 'utf8'), /acme/);
  assert.equal(one("SELECT id FROM domains WHERE name LIKE '%acme%'"), undefined);
  assert.ok(existsSync(dry('/etc/nginx/vexpanel/other.test.conf')));

  const audit = await admin.call('GET', '/api/admin/audit');
  assert.ok(audit.body.some((a: { action: string }) => a.action === 'account.terminate'));
});
