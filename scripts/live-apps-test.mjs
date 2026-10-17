// Live test of the IP preview and the WordPress app installer on a REAL, disposable install.
// Run as root: node scripts/live-apps-test.mjs (the server must be able to download WordPress).
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const B = 'https://127.0.0.1:2083';
let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, String(extra).slice(0, 400)); } };
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return `ERR ${e.status} ${e.stderr || e.stdout}`; } };
const http = (path, host = '127.0.0.1') => sh('curl', ['-s', '-m', '20', '-H', `Host: ${host}`, '-o', '-', '-w', '\n%{http_code}', `http://127.0.0.1${path}`]);
const code = (r) => r.trim().split('\n').pop();

function client() {
  const jar = {};
  return async (m, u, b) => {
    const go = () => fetch(B + u, { method: m, headers: { 'content-type': 'application/json', cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), 'x-csrf-token': jar.vex_csrf || '' }, body: b ? JSON.stringify(b) : undefined });
    const r = await go().catch(() => go());
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (v) jar[k] = v; else delete jar[k]; }
    const t = await r.text();
    return { status: r.status, body: t ? JSON.parse(t) : null };
  };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitInstall(c, id) {
  for (let i = 0; i < 120; i++) {
    const r = await c('GET', '/api/apps');
    const row = r.body.installs.find((x) => x.id === id);
    if (row.status !== 'installing') return row;
    await wait(1000);
  }
  return { status: 'timeout' };
}

const adminPw = readFileSync('/var/lib/vexpanel/initial-admin.txt', 'utf8').match(/password: (\S+)/)[1];
const a = client();
await a('POST', '/api/auth/login', { username: 'admin', password: adminPw });
const pk = (await a('GET', '/api/admin/packages')).body.find((p) => p.name === 'Business').id;
for (const x of (await a('GET', '/api/admin/accounts')).body) if (['demo', 'demo2'].includes(x.username)) await a('DELETE', `/api/admin/accounts/${x.id}`, { confirm: x.username });

console.log('IP preview');
const rootPage = http('/');
ok(rootPage.includes('managed by VEXPANEL') && code(rootPage) === '200', 'IP root answers with neutral page', rootPage);
ok((await a('POST', '/api/admin/accounts', { username: 'demo', password: 'Demo-pass-12345', email: 'd@demo.test', domain: 'demo.test', packageId: pk })).status === 200, 'account demo created');
ok(http('/~demo/').includes('hosted with VEXPANEL'), 'welcome page at /~demo/');
ok(code(http('/~demo')) === '301', '/~demo redirects to /~demo/');
const u = client();
await u('POST', '/api/auth/login', { username: 'demo', password: 'Demo-pass-12345' });
await u('POST', '/api/files/write', { path: 'public_html/who.php', content: "<?php echo get_current_user() . '|' . posix_getpwuid(posix_geteuid())['name'] . '|' . __DIR__;" });
const who = http('/~demo/who.php');
ok(who.startsWith('demo|demo|/home/demo/public_html'), 'PHP by IP runs as demo, real path under /home', who);
ok(code(http('/~demo/.hidden')) === '403', 'dotfiles denied');
ok(code(http('/~nobody/')) === '404', 'unknown user 404');
ok(code(http('/index.nginx-debian.html')) === '404', 'stock nginx files not exposed');
await u('POST', '/api/files/delete', { paths: ['public_html/who.php'] });

console.log('WordPress by IP (fully automatic)');
const inst = await u('POST', '/api/apps/install', { appId: 'wordpress', location: 'ip', folder: '', title: 'Demo Blog', adminUser: 'demoadmin', adminPassword: 'Wp-admin-pass-1', adminEmail: 'd@demo.test' });
ok(inst.status === 200, 'install started', JSON.stringify(inst.body));
const row = await waitInstall(u, inst.body.id);
ok(row.status === 'ready', `install finished: ${row.status}`, row.message);
const home = http('/~demo/');
ok(home.includes('Demo Blog') && code(home) === '200', 'WordPress homepage served with the site title', home.slice(0, 300));
ok(code(http('/~demo/wp-login.php')) === '200', 'wp-login.php loads');
ok(sh('stat', ['-c', '%U', '/home/demo/public_html/wp-config.php']).trim() === 'demo', 'files owned by demo');
ok(!sh('ls', ['/home/demo/tmp']).includes('vex-'), 'temp files cleaned up');
ok(sh('mariadb', ['-N', '-e', "SELECT option_value FROM demo_wordpres.wp_options WHERE option_name='siteurl'"]).trim() === 'http://127.0.0.1/~demo', 'siteurl set to the IP preview URL');
// Real login through the browser flow.
const jar = '/tmp/wpjar';
sh('rm', ['-f', jar]);
sh('curl', ['-s', '-c', jar, '-b', jar, 'http://127.0.0.1/~demo/wp-login.php', '-o', '/dev/null']);
const login = sh('curl', ['-s', '-c', jar, '-b', jar, '-o', '/dev/null', '-w', '%{http_code} %{redirect_url}', '--data-urlencode', 'log=demoadmin', '--data-urlencode', 'pwd=Wp-admin-pass-1', '--data-urlencode', 'testcookie=1', '-b', 'wordpress_test_cookie=WP%20Cookie%20check', 'http://127.0.0.1/~demo/wp-login.php']);
ok(login.startsWith('302') && login.includes('/~demo/wp-admin/'), 'admin can log in with the chosen password', login);

if (process.env.STOP) { console.log(pass, fail); process.exit(0); }
console.log('Nested app in a subfolder, then remove the parent');
const sub = await u('POST', '/api/apps/install', { appId: 'wordpress', location: 'ip', folder: 'blog', title: 'Second', adminUser: 'demoadmin', adminPassword: 'Wp-admin-pass-1', adminEmail: 'd@demo.test' });
const subRow = await waitInstall(u, sub.body.id);
ok(subRow.status === 'ready', 'second WordPress in /blog', subRow.message);
ok(http('/~demo/blog/').includes('Second'), '/~demo/blog/ serves the second site');
ok((await u('POST', `/api/apps/${inst.body.id}/remove`, { dropDatabase: true })).status === 200, 'remove root WordPress');
ok(!existsSync('/home/demo/public_html/wp-config.php') && existsSync('/home/demo/public_html/blog/wp-config.php'), 'root app removed, nested app kept');
ok(sh('mariadb', ['-N', '-e', "SHOW DATABASES LIKE 'demo_wordpres'"]).trim() === '', 'its database dropped');
ok(http('/~demo/blog/').includes('Second'), 'nested app still works');

console.log('Install by domain');
const locs = (await u('GET', '/api/apps')).body.locations;
const dom = locs.find((l) => l.label === 'demo.test');
const d1 = await u('POST', '/api/apps/install', { appId: 'wordpress', location: dom.id, folder: 'news', title: 'Domain Site', adminUser: 'demoadmin', adminPassword: 'Wp-admin-pass-1', adminEmail: 'd@demo.test' });
const d1Row = await waitInstall(u, d1.body.id);
ok(d1Row.status === 'ready' && d1Row.url === 'http://demo.test/news/', 'installed at http://demo.test/news/', JSON.stringify(d1Row));
ok(http('/news/', 'demo.test').includes('Domain Site'), 'served on the domain vhost');

console.log('Suspend');
const demoId = (await a('GET', '/api/admin/accounts')).body.find((x) => x.username === 'demo').id;
await a('POST', `/api/admin/accounts/${demoId}/suspend`);
await wait(800); // nginx reloads gracefully
ok(http('/~demo/blog/').includes('unavailable'), 'IP preview shows suspended page');
await a('POST', `/api/admin/accounts/${demoId}/unsuspend`);
await wait(800);
ok(http('/~demo/blog/').includes('Second'), 'back after unsuspend');

console.log('Terminate');
ok((await a('DELETE', `/api/admin/accounts/${demoId}`, { confirm: 'demo' })).status === 200, 'terminated');
ok(code(http('/~demo/')) === '404', '/~demo/ gone');
ok(!sh('nginx', ['-t']).startsWith('ERR'), 'nginx config valid');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
