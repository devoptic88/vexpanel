import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { actor, requireAccount } from '../auth.js';
import { all, audit, exec, one, tx, type DnsRecordRow, type DomainRow, type PackageRow, type UserRow } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import * as accounts from '../services/accounts.js';
import { applyCron } from '../services/cron.js';
import { applyZone, zoneFor } from '../services/dns.js';
import { downloadStream, fileOp } from '../services/files.js';
import { applyMail, dovecotHash, removeMailboxDir } from '../services/mail.js';
import * as mysql from '../services/mysql.js';
import { disableSsl, issueCertificate } from '../services/ssl.js';
import { serial } from '../sys/exec.js';
import { previewUrl } from '../services/web.js';
import { config } from '../config.js';
import * as v from '../validate.js';

type Body = Record<string, unknown>;
const body = (req: FastifyRequest) => (req.body ?? {}) as Body;

function ownDomain(u: UserRow, id: unknown, types: string[] = ['main', 'addon', 'sub']): DomainRow {
  const d = one<DomainRow>('SELECT * FROM domains WHERE id = ? AND user_id = ?', Number(id), u.id);
  if (!d || !types.includes(d.type)) throw notFound('Domain not found.');
  return d;
}

export default async function userRoutes(app: FastifyInstance) {
  const read = (req: FastifyRequest) => requireAccount(req);
  const write = (req: FastifyRequest) => requireAccount(req, { write: true });
  const log = (req: FastifyRequest, action: string, detail = '') => audit(actor(req), action, detail, req.ip);

  // ---- Overview ----
  app.get('/api/user/overview', async (req) => {
    const u = read(req);
    const pkg = one<PackageRow>('SELECT * FROM packages WHERE id = ?', u.package_id)!;
    const main = one<DomainRow>("SELECT * FROM domains WHERE user_id = ? AND type = 'main'", u.id);
    return {
      username: u.username,
      domain: main?.name ?? null,
      home: `${config.homeBase}/${u.username}`,
      serverIp: config.serverIp,
      previewUrl: previewUrl(u.username),
      nameservers: config.nameservers,
      hostname: config.hostname,
      package: pkg,
      usage: {
        diskBytes: u.disk_used_bytes,
        diskCheckedAt: u.disk_checked_at,
        addon: accounts.count('domains', u.id, "AND type = 'addon'"),
        sub: accounts.count('domains', u.id, "AND type = 'sub'"),
        databases: accounts.count('databases', u.id),
        email: accounts.count('mail_accounts', u.id),
        cron: accounts.count('cron_jobs', u.id),
      },
    };
  });

  app.post('/api/user/refresh-disk', async (req) => ({ bytes: await accounts.refreshDiskUsage(read(req)) }));

  // ---- Domains ----
  app.get('/api/domains', async (req) => {
    const u = read(req);
    return all<DomainRow>('SELECT * FROM domains WHERE user_id = ? ORDER BY type, name', u.id).map((d) => ({
      ...d,
      docroot: path.posix.relative(`${config.homeBase}/${u.username}`, d.docroot),
    }));
  });

  app.post('/api/domains', async (req) => {
    const u = write(req);
    const b = body(req);
    const d = await accounts.addDomain(u, { ...b, type: b.type });
    log(req, 'domain.add', d.name);
    return d;
  });

  app.delete<{ Params: { id: string } }>('/api/domains/:id', async (req) => {
    const u = write(req);
    const d = ownDomain(u, req.params.id);
    await accounts.removeDomain(u, d.id);
    log(req, 'domain.remove', d.name);
    return { ok: true };
  });

  // ---- Files ----
  app.get<{ Querystring: { path?: string } }>('/api/files/list', async (req) => fileOp(read(req), 'list', { path: v.relPath(req.query.path) }));
  app.get<{ Querystring: { path?: string } }>('/api/files/read', async (req) => fileOp(read(req), 'read', { path: v.relPath(req.query.path) }));

  app.post('/api/files/write', async (req) => {
    const b = body(req);
    const content = String(b.content ?? '');
    if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw badRequest('Content is larger than 2 MB.');
    return fileOp(write(req), 'write', { path: v.relPath(b.path) }, content);
  });
  app.post('/api/files/mkdir', async (req) => fileOp(write(req), 'mkdir', { path: v.relPath(body(req).path) }));
  app.post('/api/files/rename', async (req) => {
    const b = body(req);
    return fileOp(write(req), 'rename', { from: v.relPath(b.from), to: v.relPath(b.to) });
  });
  app.post('/api/files/delete', async (req) => {
    const paths = body(req).paths;
    if (!Array.isArray(paths) || paths.length === 0) throw badRequest('Nothing selected.');
    return fileOp(write(req), 'remove', { paths: paths.map((p) => v.relPath(p)) });
  });
  app.post('/api/files/chmod', async (req) => {
    const b = body(req);
    return fileOp(write(req), 'chmod', { path: v.relPath(b.path), mode: String(b.mode ?? '') });
  });

  app.post<{ Querystring: { path?: string } }>('/api/files/upload', async (req) => {
    const u = write(req);
    const dir = v.relPath(req.query.path);
    const uploaded: string[] = [];
    for await (const part of req.files()) {
      const name = path.posix.basename(part.filename.replace(/\\/g, '/'));
      if (!name || name === '.' || name === '..') throw badRequest('Invalid file name.');
      await fileOp(u, 'upload', { path: dir ? `${dir}/${name}` : name }, part.file);
      if (part.file.truncated) throw badRequest(`${name} is larger than the upload limit.`);
      uploaded.push(name);
    }
    return { uploaded };
  });

  app.get<{ Querystring: { path?: string } }>('/api/files/download', async (req, reply) => {
    const u = read(req);
    const rel = v.relPath(req.query.path);
    const stream = await downloadStream(u, rel);
    const name = path.posix.basename(rel).replace(/[^\w.\- ]/g, '_');
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename="${name}"`);
    return reply.send(stream);
  });

  // ---- Databases ----
  app.get('/api/databases', async (req) => {
    const u = read(req);
    const dbs = all<{ id: number; name: string }>('SELECT id, name FROM databases WHERE user_id = ? ORDER BY name', u.id);
    const users = all<{ id: number; name: string }>('SELECT id, name FROM db_users WHERE user_id = ? ORDER BY name', u.id);
    const grants = all<{ database_id: number; db_user_id: number }>(
      'SELECT g.* FROM db_grants g JOIN databases d ON d.id = g.database_id WHERE d.user_id = ?', u.id,
    );
    const sizes = await mysql.databaseSizes(dbs.map((d) => d.name));
    return {
      prefix: `${u.username}_`,
      databases: dbs.map((d) => ({ ...d, sizeBytes: sizes[d.name] ?? null, users: grants.filter((g) => g.database_id === d.id).map((g) => g.db_user_id) })),
      users,
    };
  });

  app.post('/api/databases', async (req) => {
    const u = write(req);
    accounts.limitCheck(u, 'db');
    const name = v.dbSuffix(body(req).name, u.username, 64);
    if (one('SELECT id FROM databases WHERE name = ?', name)) throw conflict(`${name} already exists.`);
    await serial(() => mysql.createDatabase(name));
    exec('INSERT INTO databases (user_id, name) VALUES (?, ?)', u.id, name);
    log(req, 'db.create', name);
    return { ok: true, name };
  });

  app.delete<{ Params: { id: string } }>('/api/databases/:id', async (req) => {
    const u = write(req);
    const d = one<{ id: number; name: string }>('SELECT * FROM databases WHERE id = ? AND user_id = ?', Number(req.params.id), u.id);
    if (!d) throw notFound();
    await serial(() => mysql.dropDatabase(d.name));
    exec('DELETE FROM databases WHERE id = ?', d.id);
    log(req, 'db.drop', d.name);
    return { ok: true };
  });

  app.post('/api/databases/users', async (req) => {
    const u = write(req);
    const b = body(req);
    const name = v.dbSuffix(b.name, u.username, 32);
    const pw = v.password(b.password, 12);
    if (one('SELECT id FROM db_users WHERE name = ?', name)) throw conflict(`${name} already exists.`);
    await serial(() => mysql.createUser(name, pw));
    exec('INSERT INTO db_users (user_id, name) VALUES (?, ?)', u.id, name);
    log(req, 'dbuser.create', name);
    return { ok: true, name };
  });

  app.post<{ Params: { id: string } }>('/api/databases/users/:id/password', async (req) => {
    const u = write(req);
    const du = one<{ id: number; name: string }>('SELECT * FROM db_users WHERE id = ? AND user_id = ?', Number(req.params.id), u.id);
    if (!du) throw notFound();
    await serial(() => mysql.setUserPassword(du.name, v.password(body(req).password, 12)));
    log(req, 'dbuser.password', du.name);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/databases/users/:id', async (req) => {
    const u = write(req);
    const du = one<{ id: number; name: string }>('SELECT * FROM db_users WHERE id = ? AND user_id = ?', Number(req.params.id), u.id);
    if (!du) throw notFound();
    await serial(() => mysql.dropUser(du.name));
    exec('DELETE FROM db_users WHERE id = ?', du.id);
    log(req, 'dbuser.drop', du.name);
    return { ok: true };
  });

  app.post('/api/databases/grants', async (req) => {
    const u = write(req);
    const b = body(req);
    const d = one<{ id: number; name: string }>('SELECT * FROM databases WHERE id = ? AND user_id = ?', Number(b.databaseId), u.id);
    const du = one<{ id: number; name: string }>('SELECT * FROM db_users WHERE id = ? AND user_id = ?', Number(b.userId), u.id);
    if (!d || !du) throw notFound();
    const grant = b.grant !== false;
    await serial(() => (grant ? mysql.grantAll(d.name, du.name) : mysql.revokeAll(d.name, du.name)));
    if (grant) exec('INSERT OR IGNORE INTO db_grants (database_id, db_user_id) VALUES (?, ?)', d.id, du.id);
    else exec('DELETE FROM db_grants WHERE database_id = ? AND db_user_id = ?', d.id, du.id);
    log(req, grant ? 'db.grant' : 'db.revoke', `${du.name} → ${d.name}`);
    return { ok: true };
  });

  // ---- Email ----
  app.get('/api/email', async (req) => {
    const u = read(req);
    return {
      domains: all('SELECT id, name FROM domains WHERE user_id = ? AND type IN (\'main\',\'addon\') ORDER BY name', u.id),
      accounts: all(
        `SELECT m.id, m.local_part, m.quota_mb, d.name AS domain, d.id AS domain_id
         FROM mail_accounts m JOIN domains d ON d.id = m.domain_id WHERE m.user_id = ? ORDER BY d.name, m.local_part`, u.id),
      forwarders: all(
        `SELECT f.id, f.local_part, f.destination, d.name AS domain
         FROM mail_forwarders f JOIN domains d ON d.id = f.domain_id WHERE f.user_id = ? ORDER BY d.name, f.local_part`, u.id),
      server: { imap: `mail.<your domain>:993 (SSL)`, smtp: `mail.<your domain>:587 (STARTTLS)`, hostname: config.hostname },
    };
  });

  app.post('/api/email/accounts', async (req) => {
    const u = write(req);
    accounts.limitCheck(u, 'mail');
    const b = body(req);
    const d = ownDomain(u, b.domainId, ['main', 'addon']);
    const local = v.mailLocal(b.local);
    const pw = v.password(b.password);
    const quota = b.quotaMb === undefined || b.quotaMb === '' ? 1024 : v.int(b.quotaMb, 'Quota (MB)', 10, 1_000_000);
    if (one('SELECT id FROM mail_accounts WHERE domain_id = ? AND local_part = ?', d.id, local)) throw conflict(`${local}@${d.name} already exists.`);
    const r = exec('INSERT INTO mail_accounts (user_id, domain_id, local_part, password_hash, quota_mb) VALUES (?, ?, ?, ?, ?)', u.id, d.id, local, dovecotHash(pw), quota);
    try {
      await applyMail();
    } catch (err) {
      exec('DELETE FROM mail_accounts WHERE id = ?', r.lastInsertRowid);
      throw err;
    }
    log(req, 'mail.create', `${local}@${d.name}`);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/email/accounts/:id/password', async (req) => {
    const u = write(req);
    const m = one<{ id: number }>('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ?', Number(req.params.id), u.id);
    if (!m) throw notFound();
    exec('UPDATE mail_accounts SET password_hash = ? WHERE id = ?', dovecotHash(v.password(body(req).password)), m.id);
    await applyMail();
    log(req, 'mail.password', String(m.id));
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/email/accounts/:id', async (req) => {
    const u = write(req);
    const m = one<{ id: number; local_part: string; domain: string }>(
      'SELECT m.id, m.local_part, d.name AS domain FROM mail_accounts m JOIN domains d ON d.id = m.domain_id WHERE m.id = ? AND m.user_id = ?',
      Number(req.params.id), u.id,
    );
    if (!m) throw notFound();
    exec('DELETE FROM mail_accounts WHERE id = ?', m.id);
    await applyMail();
    await removeMailboxDir(m.domain, m.local_part);
    log(req, 'mail.delete', `${m.local_part}@${m.domain}`);
    return { ok: true };
  });

  app.post('/api/email/forwarders', async (req) => {
    const u = write(req);
    const b = body(req);
    const d = ownDomain(u, b.domainId, ['main', 'addon']);
    const local = v.mailLocal(b.local);
    const dest = v.email(b.destination);
    if (dest === `${local}@${d.name}`) throw badRequest('A forwarder cannot point to itself.');
    if (count(u.id) >= 500) throw badRequest('Too many forwarders.');
    if (one('SELECT id FROM mail_forwarders WHERE domain_id = ? AND local_part = ? AND destination = ?', d.id, local, dest)) throw conflict('That forwarder exists.');
    const r = exec('INSERT INTO mail_forwarders (user_id, domain_id, local_part, destination) VALUES (?, ?, ?, ?)', u.id, d.id, local, dest);
    try {
      await applyMail();
    } catch (err) {
      exec('DELETE FROM mail_forwarders WHERE id = ?', r.lastInsertRowid);
      throw err;
    }
    log(req, 'forwarder.create', `${local}@${d.name} → ${dest}`);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/email/forwarders/:id', async (req) => {
    const u = write(req);
    const r = exec('DELETE FROM mail_forwarders WHERE id = ? AND user_id = ?', Number(req.params.id), u.id);
    if (!r.changes) throw notFound();
    await applyMail();
    log(req, 'forwarder.delete', req.params.id);
    return { ok: true };
  });

  // ---- DNS ----
  app.get<{ Params: { id: string } }>('/api/dns/:id', async (req) => {
    const u = read(req);
    const d = ownDomain(u, req.params.id, ['main', 'addon']);
    return { zone: d.name, serial: d.dns_serial, records: all<DnsRecordRow>('SELECT * FROM dns_records WHERE domain_id = ? ORDER BY type, name, id', d.id) };
  });

  async function saveRecord(req: FastifyRequest, domainId: unknown, recordId: number | null) {
    const u = write(req);
    const d = ownDomain(u, domainId, ['main', 'addon']);
    const r = v.dnsRecord(body(req));
    if (r.type === 'CNAME') {
      const clash = one('SELECT id FROM dns_records WHERE domain_id = ? AND name = ? AND id IS NOT ?', d.id, r.name, recordId);
      if (clash) throw conflict(`A CNAME can't share the name "${r.name}" with other records.`);
      if (r.name === '@') throw badRequest('The zone apex (@) cannot be a CNAME.');
    } else if (one("SELECT id FROM dns_records WHERE domain_id = ? AND name = ? AND type = 'CNAME' AND id IS NOT ?", d.id, r.name, recordId)) {
      throw conflict(`"${r.name}" already has a CNAME; it can't have other records.`);
    }
    const before = recordId ? one<DnsRecordRow>('SELECT * FROM dns_records WHERE id = ? AND domain_id = ?', recordId, d.id) : null;
    if (recordId && !before) throw notFound();
    const id = tx(() => {
      if (recordId) {
        exec('UPDATE dns_records SET name=?, type=?, value=?, ttl=?, priority=? WHERE id=?', r.name, r.type, r.value, r.ttl, r.priority, recordId);
        return recordId;
      }
      return exec('INSERT INTO dns_records (domain_id, name, type, value, ttl, priority) VALUES (?, ?, ?, ?, ?, ?)', d.id, r.name, r.type, r.value, r.ttl, r.priority).lastInsertRowid;
    });
    try {
      await serial(() => applyZone(d.id));
    } catch (err) {
      // named-checkzone rejected it: put the record back the way it was.
      if (before) exec('UPDATE dns_records SET name=?, type=?, value=?, ttl=?, priority=? WHERE id=?', before.name, before.type, before.value, before.ttl, before.priority, before.id);
      else exec('DELETE FROM dns_records WHERE id = ?', id);
      throw err;
    }
    log(req, recordId ? 'dns.update' : 'dns.add', `${d.name} ${r.name} ${r.type} ${r.value}`);
    return { ok: true, id };
  }

  app.post<{ Params: { id: string } }>('/api/dns/:id/records', async (req) => saveRecord(req, req.params.id, null));
  app.put<{ Params: { id: string; rid: string } }>('/api/dns/:id/records/:rid', async (req) => saveRecord(req, req.params.id, Number(req.params.rid)));

  app.delete<{ Params: { id: string; rid: string } }>('/api/dns/:id/records/:rid', async (req) => {
    const u = write(req);
    const d = ownDomain(u, req.params.id, ['main', 'addon']);
    const rec = one<DnsRecordRow>('SELECT * FROM dns_records WHERE id = ? AND domain_id = ?', Number(req.params.rid), d.id);
    if (!rec) throw notFound();
    exec('DELETE FROM dns_records WHERE id = ?', rec.id);
    await serial(() => applyZone(d.id));
    log(req, 'dns.delete', `${d.name} ${rec.name} ${rec.type} ${rec.value}`);
    return { ok: true };
  });

  // ---- SSL ----
  app.get('/api/ssl', async (req) => {
    const u = read(req);
    return all('SELECT id, name, type, ssl, ssl_expires FROM domains WHERE user_id = ? ORDER BY name', u.id);
  });

  app.post<{ Params: { id: string } }>('/api/ssl/:id/issue', async (req) => {
    const u = write(req);
    const d = ownDomain(u, req.params.id);
    const r = await issueCertificate(d.id, body(req).www !== false);
    log(req, 'ssl.issue', d.name);
    return { ok: true, ...r };
  });

  app.post<{ Params: { id: string } }>('/api/ssl/:id/disable', async (req) => {
    const u = write(req);
    const d = ownDomain(u, req.params.id);
    await disableSsl(d.id);
    log(req, 'ssl.disable', d.name);
    return { ok: true };
  });

  // ---- Cron ----
  app.get('/api/cron', async (req) => {
    const u = read(req);
    return all('SELECT id, schedule, command, created_at FROM cron_jobs WHERE user_id = ? ORDER BY id', u.id);
  });

  app.post('/api/cron', async (req) => {
    const u = write(req);
    accounts.limitCheck(u, 'cron');
    const b = body(req);
    const r = exec('INSERT INTO cron_jobs (user_id, schedule, command) VALUES (?, ?, ?)', u.id, v.cronSchedule(b.schedule), v.cronCommand(b.command));
    try {
      await applyCron(u.id);
    } catch (err) {
      exec('DELETE FROM cron_jobs WHERE id = ?', r.lastInsertRowid);
      throw err;
    }
    log(req, 'cron.add', String(b.command));
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/cron/:id', async (req) => {
    const u = write(req);
    const r = exec('DELETE FROM cron_jobs WHERE id = ? AND user_id = ?', Number(req.params.id), u.id);
    if (!r.changes) throw notFound();
    await applyCron(u.id);
    log(req, 'cron.delete', req.params.id);
    return { ok: true };
  });

  function count(userId: number) {
    return one<{ n: number }>('SELECT COUNT(*) AS n FROM mail_forwarders WHERE user_id = ?', userId)!.n;
  }

  // Used by the subdomain form: zone lookup for a domain's DNS host.
  app.get<{ Params: { id: string } }>('/api/domains/:id/zone', async (req) => {
    const u = read(req);
    const d = ownDomain(u, req.params.id);
    return { zoneId: zoneFor(d).id };
  });
}
