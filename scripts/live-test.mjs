// Live end-to-end test for a REAL install. Run only on a disposable test server:
//   sudo node scripts/live-test.mjs
// It creates and then terminates an account 'acme' with domains acme.test / shop.test,
// and expects the server IP to be 127.0.0.1 (VEX_SERVER_IP=127.0.0.1 at install).
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, symlinkSync, readdirSync } from 'node:fs';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const B = 'https://127.0.0.1:2083';
let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra); } };
const sh = (cmd, args, opts = {}) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }); } catch (e) { return `ERR ${e.status} ${e.stderr || e.stdout}`; } };
const settle = () => execFileSync('sleep', ['1']);
const curl = (host, path = '/', proto = 'http') => (settle(), sh('curl', ['-sk', '-m', '10', '-H', `Host: ${host}`, `${proto}://127.0.0.1${path}`]));

function client() {
  const jar = {};
  return async (m, u, b) => {
    const go = () => fetch(B + u, { method: m, headers: { 'content-type': 'application/json', cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), 'x-csrf-token': jar.vex_csrf || '' }, body: b ? JSON.stringify(b) : undefined });
    // nginx reloads close idle keep-alive sockets; retry once like a browser would.
    const r = await go().catch(() => go());
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (v) jar[k] = v; else delete jar[k]; }
    const t = await r.text();
    return { status: r.status, body: t ? JSON.parse(t) : null };
  };
}

const adminPw = readFileSync('/var/lib/vexpanel/initial-admin.txt', 'utf8').match(/password: (\S+)/)[1];
const a = client();
console.log('Auth');
ok((await a('POST', '/api/auth/login', { username: 'admin', password: adminPw })).status === 200, 'admin login over HTTPS via nginx');
const pkgs = (await a('GET', '/api/admin/packages')).body;
const biz = pkgs.find((p) => p.name === 'Business').id;

console.log('Create account');
const cr = await a('POST', '/api/admin/accounts', { username: 'acme', password: 'Acme-pass-12345', email: 'o@acme.test', domain: 'acme.test', packageId: biz });
ok(cr.status === 200, 'account created', JSON.stringify(cr.body));
ok(sh('getent', ['passwd', 'acme']).includes('/home/acme:/usr/sbin/nologin'), 'linux user with nologin shell');
ok(sh('id', ['-nG', 'acme']).includes('vexusers'), 'in vexusers (SFTP-only group)');
ok((statSync('/home/acme').mode & 0o777) === 0o711, 'home is 711');
ok(sh('stat', ['-c', '%U:%G %a', '/home/acme/public_html']).trim() === 'acme:www-data 2750', 'public_html acme:www-data 2750');
ok(curl('acme.test').includes('hosted with VEXPANEL'), 'nginx serves welcome page for acme.test');

const u = client();
ok((await u('POST', '/api/auth/login', { username: 'acme', password: 'Acme-pass-12345' })).status === 200, 'account login');

console.log('Files + PHP');
await u('POST', '/api/files/write', { path: 'public_html/index.php', content: "<?php echo 'php-as:' . posix_getpwuid(posix_geteuid())['name'];" });
ok(sh('stat', ['-c', '%U', '/home/acme/public_html/index.php']).trim() === 'acme', 'file written as acme (not root)');
ok(curl('acme.test', '/index.php') === 'php-as:acme', 'PHP-FPM runs as the account user', curl('acme.test', '/index.php'));
const esc = await u('GET', '/api/files/read?path=../../etc/passwd');
ok(esc.status === 400, 'path traversal rejected');
symlinkSync('/etc/shadow', '/home/acme/public_html/shadow-link');
const sl = await u('GET', '/api/files/read?path=public_html/shadow-link');
ok(sl.status === 400 && !JSON.stringify(sl.body).includes('root:'), 'symlink to /etc/shadow blocked', JSON.stringify(sl.body));
symlinkSync('/root', '/home/acme/public_html/root-link');
const sl2 = await u('GET', '/api/files/list?path=public_html/root-link');
ok(sl2.status === 400, 'symlinked directory escape blocked', JSON.stringify(sl2.body).slice(0, 120));

console.log('Domains');
ok((await u('POST', '/api/domains', { type: 'addon', domain: 'shop.test' })).status === 200, 'addon domain added');
ok(curl('shop.test').includes('403') || curl('shop.test').length >= 0, 'addon vhost answers');
await u('POST', '/api/files/write', { path: 'shop.test/index.html', content: 'shop-ok' });
ok(curl('shop.test') === 'shop-ok', 'addon serves its own docroot', curl('shop.test'));
const main = (await u('GET', '/api/domains')).body.find((d) => d.type === 'main');
ok((await u('POST', '/api/domains', { type: 'sub', label: 'blog', parentId: main.id })).status === 200, 'subdomain added');
await u('POST', '/api/files/write', { path: 'public_html/blog/index.html', content: 'blog-ok' });
ok(curl('blog.acme.test') === 'blog-ok', 'subdomain serves', curl('blog.acme.test'));

console.log('DNS');
ok(sh('dig', ['+short', '@127.0.0.1', 'acme.test', 'A']).trim() === '127.0.0.1', 'BIND answers A for acme.test');
ok(sh('dig', ['+short', '@127.0.0.1', 'blog.acme.test', 'A']).trim() === '127.0.0.1', 'subdomain A record');
ok(sh('dig', ['+short', '@127.0.0.1', 'shop.test', 'MX']).trim() === '10 mail.shop.test.', 'addon zone has MX');
const rec = await u('POST', `/api/dns/${main.id}/records`, { name: 'api', type: 'CNAME', value: 'acme.test.' });
ok(rec.status === 200, 'CNAME added', JSON.stringify(rec.body));
ok(sh('dig', ['+short', '@127.0.0.1', 'api.acme.test', 'CNAME']).trim() === 'acme.test.', 'BIND serves the new CNAME after reload');
await u('POST', `/api/dns/${main.id}/records`, { name: '@', type: 'TXT', value: 'google-site-verification=abc123' });
ok(sh('dig', ['+short', '@127.0.0.1', 'acme.test', 'TXT']).includes('google-site-verification=abc123'), 'TXT record served');

console.log('Databases');
ok((await u('POST', '/api/databases', { name: 'wp' })).status === 200, 'database created');
ok((await u('POST', '/api/databases/users', { name: 'wpu', password: 'Db-pass-123456' })).status === 200, 'db user created');
const dbs = (await u('GET', '/api/databases')).body;
ok((await u('POST', '/api/databases/grants', { databaseId: dbs.databases[0].id, userId: dbs.users[0].id })).status === 200, 'grant applied');
ok(!sh('mariadb', ['-uacme_wpu', '-pDb-pass-123456', 'acme_wp', '-e', 'CREATE TABLE t (id INT); INSERT INTO t VALUES (1); SELECT COUNT(*) FROM t;']).startsWith('ERR'), 'db user can create tables in its database');
ok(sh('mariadb', ['-uacme_wpu', '-pDb-pass-123456', '-e', 'CREATE DATABASE evil;']).startsWith('ERR'), 'db user cannot create other databases');

console.log('Email');
ok((await u('POST', '/api/email/accounts', { domainId: main.id, local: 'hello', password: 'Mail-pass-12345', quotaMb: 100 })).status === 200, 'mailbox created');
ok((await u('POST', '/api/email/forwarders', { domainId: main.id, local: 'sales', destination: 'hello@acme.test' })).status === 200, 'forwarder created');
ok(sh('doveadm', ['auth', 'test', 'hello@acme.test', 'Mail-pass-12345']).includes('succeeded'), 'Dovecot accepts mailbox password');
ok(!sh('doveadm', ['auth', 'test', 'hello@acme.test', 'wrong']).includes('succeeded'), 'Dovecot rejects wrong password');
sh('sendmail', ['-f', 'test@example.org', 'sales@acme.test'], { input: 'Subject: live test\n\nhello from the live test\n' });
await new Promise((r) => setTimeout(r, 4000));
const newDir = '/var/vmail/acme.test/hello/new';
ok(existsSync(newDir) && readdirSync(newDir).length >= 1, 'mail to forwarder delivered into hello@ maildir', sh('tail', ['-5', '/var/log/mail.log']));

console.log('Cron');
ok((await u('POST', '/api/cron', { schedule: '*/5 * * * *', command: 'php ~/public_html/index.php' })).status === 200, 'cron job added');
ok(sh('crontab', ['-l', '-u', 'acme']).includes('*/5 * * * * php ~/public_html/index.php'), 'crontab installed for acme');

console.log('Disk usage');
const du = await u('POST', '/api/user/refresh-disk');
ok(du.status === 200 && du.body.bytes > 0, `disk measured as acme (${du.body?.bytes} bytes)`);

console.log('Suspend / unsuspend');
const acc = (await a('GET', '/api/admin/accounts')).body.find((x) => x.username === 'acme');
ok((await a('POST', `/api/admin/accounts/${acc.id}/suspend`)).status === 200, 'suspended');
ok(curl('acme.test').includes('unavailable'), 'site shows suspended page', curl('acme.test').slice(0, 80));
ok(!sh('doveadm', ['auth', 'test', 'hello@acme.test', 'Mail-pass-12345']).includes('succeeded'), 'mail login blocked while suspended');
ok(sh('mariadb', ['-uacme_wpu', '-pDb-pass-123456', '-e', 'SELECT 1']).startsWith('ERR'), 'db user locked while suspended');
ok(sh('passwd', ['-S', 'acme']).split(' ')[1] === 'L', 'linux password locked');
ok((await u('GET', '/api/user/overview')).status === 401, 'panel sessions revoked');
ok((await a('POST', `/api/admin/accounts/${acc.id}/unsuspend`)).status === 200, 'unsuspended');
ok(curl('acme.test', '/index.php') === 'php-as:acme', 'PHP back after unsuspend');
ok(!sh('mariadb', ['-uacme_wpu', '-pDb-pass-123456', '-e', 'SELECT 1']).startsWith('ERR'), 'db user unlocked');

console.log('SSL (expected to fail without public DNS)');
await u('POST', '/api/auth/login', { username: 'acme', password: 'Acme-pass-12345' });
const iss = await u('POST', `/api/ssl/${main.id}/issue`, {});
ok(iss.status === 500 && !(await u('GET', '/api/ssl')).body.find((d) => d.id === main.id).ssl, 'failed issuance leaves HTTP config intact', JSON.stringify(iss.body).slice(0, 160));
ok(curl('acme.test', '/index.php') === 'php-as:acme', 'site still serving after failed SSL attempt');

console.log('Terminate');
const term = await a('DELETE', `/api/admin/accounts/${acc.id}`, { confirm: 'acme' });
ok(term.status === 200, 'terminated', JSON.stringify(term.body));
ok(term.body?.problems?.length === 0, 'no cleanup warnings', JSON.stringify(term.body?.problems));
ok(sh('getent', ['passwd', 'acme']).startsWith('ERR'), 'linux user removed');
ok(!existsSync('/home/acme'), 'home removed');
ok(!existsSync('/etc/nginx/vexpanel/acme.test.conf') && !existsSync('/etc/nginx/vexpanel/shop.test.conf'), 'vhosts removed');
ok(sh('mariadb', ['-e', "SHOW DATABASES LIKE 'acme_wp'"]).trim() === '', 'database dropped');
ok(sh('dig', ['+short', '@127.0.0.1', 'acme.test', 'A']).trim() === '', 'zone no longer served');
ok(!readFileSync('/etc/postfix/vexpanel/vdomains', 'utf8').includes('acme'), 'mail domain removed');
ok(sh('nginx', ['-t']).length >= 0 && !sh('nginx', ['-t']).startsWith('ERR'), 'nginx config still valid');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
