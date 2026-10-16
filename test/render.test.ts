import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.VEX_DATA_DIR = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'vex-r-'));
process.env.VEX_DRY_RUN = '1';
process.env.VEX_NAMESERVERS = 'ns1.h.test,ns2.h.test';

const { renderVhost, renderFpmPool } = await import('../src/server/services/web.ts');
const { renderZone, nextSerial } = await import('../src/server/services/dns.ts');
const { renderMailMaps, dovecotHash, verifyDovecotHash } = await import('../src/server/services/mail.ts');
const { renderCrontab } = await import('../src/server/services/cron.ts');
const v = await import('../src/server/validate.ts');

const d = { id: 1, user_id: 1, name: 'ex.test', type: 'main' as const, parent_id: null, docroot: '/home/ex/public_html', ssl: 0, ssl_expires: null, dns_serial: 0 };

test('vhost: plain, ssl, suspended', () => {
  const plain = renderVhost(d, { username: 'ex', status: 'active' });
  assert.match(plain, /listen 80;/);
  assert.doesNotMatch(plain, /443/);
  const ssl = renderVhost({ ...d, ssl: 1 }, { username: 'ex', status: 'active' });
  assert.match(ssl, /return 301 https/);
  assert.match(ssl, /ssl_certificate \/etc\/letsencrypt\/live\/ex\.test\/fullchain\.pem;/);
  const susp = renderVhost(d, { username: 'ex', status: 'suspended' });
  assert.doesNotMatch(susp, /fastcgi_pass/);
  const sub = renderVhost({ ...d, name: 'blog.ex.test', type: 'sub' }, { username: 'ex', status: 'active' });
  assert.match(sub, /server_name blog\.ex\.test;/);
});

test('fpm pool runs as the account user with open_basedir', () => {
  const p = renderFpmPool('ex');
  assert.match(p, /^user = ex$/m);
  assert.match(p, /open_basedir\] = \/home\/ex\//);
});

test('zone renderer quotes TXT, qualifies hosts, splits long TXT', () => {
  const z = renderZone('ex.test', 2026101600, [
    { name: '@', type: 'MX', value: 'mail', ttl: 3600, priority: 10 },
    { name: 'www', type: 'CNAME', value: 'ex.test', ttl: 3600, priority: null },
    { name: '@', type: 'TXT', value: 'x'.repeat(300), ttl: 3600, priority: null },
    { name: '_sip._tcp', type: 'SRV', value: '5 5060 sip.ex.test', ttl: 3600, priority: 10 },
  ]);
  assert.match(z, /@ 3600 IN MX 10 mail/);
  assert.match(z, /www 3600 IN CNAME ex\.test\./);
  assert.match(z, /IN TXT "x{255}" "x{45}"/);
  assert.match(z, /IN SRV 10 5 5060 sip\.ex\.test\./);
  assert.match(z, /SOA ns1\.h\.test\./);
});

test('serials always increase', () => {
  const now = new Date('2026-10-16T12:00:00Z');
  assert.equal(nextSerial(0, now), 2026101600);
  assert.equal(nextSerial(2026101600, now), 2026101601);
  assert.equal(nextSerial(2026101799, now), 2026101800);
});

test('mail maps: forwarder on a mailbox keeps a local copy', () => {
  const m = renderMailMaps(['ex.test'], [{ local_part: 'a', domain: 'ex.test', password_hash: '{SSHA512}x', quota_mb: 100, status: 'active' }], [
    { local_part: 'a', domain: 'ex.test', destination: 'b@o.test' },
    { local_part: 'c', domain: 'ex.test', destination: 'd@o.test' },
  ]);
  assert.match(m.valias, /^a@ex\.test a@ex\.test,b@o\.test$/m);
  assert.match(m.valias, /^c@ex\.test d@o\.test$/m);
  assert.match(m.users, /storage=100M/);
});

test('dovecot SSHA512 round-trips', () => {
  const h = dovecotHash('secret pass');
  assert.ok(verifyDovecotHash('secret pass', h));
  assert.ok(!verifyDovecotHash('nope', h));
});

test('crontab disables jobs when suspended', () => {
  assert.match(renderCrontab([{ id: 1, schedule: '@daily', command: 'echo hi' }], false), /@daily echo hi/);
  assert.doesNotMatch(renderCrontab([{ id: 1, schedule: '@daily', command: 'echo hi' }], true), /echo hi/);
});

test('validators reject dangerous input', () => {
  assert.throws(() => v.username('root'));
  assert.throws(() => v.username('Ab'));
  assert.throws(() => v.domain('ex..test'));
  assert.throws(() => v.domain('ex.test;rm -rf'));
  assert.throws(() => v.relPath('../etc'));
  assert.throws(() => v.password('short'));
  assert.throws(() => v.password('has:colon-long-enough'));
  assert.throws(() => v.cronCommand('a\nb'));
  assert.throws(() => v.dnsRecord({ name: 'x', type: 'TXT', value: 'a"b' }));
  assert.throws(() => v.dnsRecord({ name: 'x', type: 'A', value: '1.2.3.4\n@ IN NS evil.' }));
  assert.equal(v.domain('Example.COM.'), 'example.com');
  assert.equal(v.cronSchedule('*/15  *  * * mon-fri'), '*/15 * * * mon-fri');
  assert.equal(v.dbSuffix('wp', 'ex', 64), 'ex_wp');
});
