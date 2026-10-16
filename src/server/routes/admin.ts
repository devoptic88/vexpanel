import type { FastifyInstance } from 'fastify';
import { actor, createSession, destroySession, requireAdmin } from '../auth.js';
import { all, audit, exec, one, type PackageRow, type UserRow } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import * as accounts from '../services/accounts.js';
import { serverStats } from '../services/server.js';
import * as v from '../validate.js';
import { publicUser } from './auth.js';

type Body = Record<string, unknown>;

function packageFields(b: Body) {
  return {
    name: String(b.name ?? '').trim(),
    disk_mb: v.int(b.disk_mb, 'Disk (MB)', 100, 10_000_000),
    max_addon_domains: v.int(b.max_addon_domains, 'Addon domains', 0, 100_000),
    max_subdomains: v.int(b.max_subdomains, 'Subdomains', 0, 100_000),
    max_databases: v.int(b.max_databases, 'Databases', 0, 100_000),
    max_email_accounts: v.int(b.max_email_accounts, 'Email accounts', 0, 100_000),
    max_cron_jobs: v.int(b.max_cron_jobs, 'Cron jobs', 0, 100_000),
  };
}

export default async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => {
    requireAdmin(req);
  });

  app.get('/api/admin/stats', async () => {
    const counts = one<{ accounts: number; suspended: number; domains: number; mailboxes: number; databases: number }>(`
      SELECT (SELECT COUNT(*) FROM users WHERE role='user') AS accounts,
             (SELECT COUNT(*) FROM users WHERE role='user' AND status='suspended') AS suspended,
             (SELECT COUNT(*) FROM domains) AS domains,
             (SELECT COUNT(*) FROM mail_accounts) AS mailboxes,
             (SELECT COUNT(*) FROM databases) AS databases`)!;
    return { server: await serverStats(), counts };
  });

  // ---- Packages ----
  app.get('/api/admin/packages', async () => {
    return all<PackageRow & { accounts: number }>(
      "SELECT p.*, (SELECT COUNT(*) FROM users u WHERE u.package_id = p.id) AS accounts FROM packages p ORDER BY p.disk_mb",
    );
  });

  app.post('/api/admin/packages', async (req) => {
    const f = packageFields((req.body ?? {}) as Body);
    if (!f.name || f.name.length > 40) throw badRequest('Package name is required (max 40 characters).');
    if (one('SELECT id FROM packages WHERE name = ?', f.name)) throw conflict('A package with that name exists.');
    const r = exec(
      'INSERT INTO packages (name, disk_mb, max_addon_domains, max_subdomains, max_databases, max_email_accounts, max_cron_jobs) VALUES (?, ?, ?, ?, ?, ?, ?)',
      f.name, f.disk_mb, f.max_addon_domains, f.max_subdomains, f.max_databases, f.max_email_accounts, f.max_cron_jobs,
    );
    audit(actor(req), 'package.create', f.name, req.ip);
    return one('SELECT * FROM packages WHERE id = ?', r.lastInsertRowid);
  });

  app.put<{ Params: { id: string } }>('/api/admin/packages/:id', async (req) => {
    const id = Number(req.params.id);
    if (!one('SELECT id FROM packages WHERE id = ?', id)) throw notFound();
    const f = packageFields((req.body ?? {}) as Body);
    if (!f.name) throw badRequest('Package name is required.');
    if (one('SELECT id FROM packages WHERE name = ? AND id != ?', f.name, id)) throw conflict('A package with that name exists.');
    exec(
      'UPDATE packages SET name=?, disk_mb=?, max_addon_domains=?, max_subdomains=?, max_databases=?, max_email_accounts=?, max_cron_jobs=? WHERE id=?',
      f.name, f.disk_mb, f.max_addon_domains, f.max_subdomains, f.max_databases, f.max_email_accounts, f.max_cron_jobs, id,
    );
    // Re-apply disk quotas for everyone on this package.
    for (const u of all<{ id: number }>('SELECT id FROM users WHERE package_id = ?', id)) await accounts.changePackage(u.id, id);
    audit(actor(req), 'package.update', f.name, req.ip);
    return one('SELECT * FROM packages WHERE id = ?', id);
  });

  app.delete<{ Params: { id: string } }>('/api/admin/packages/:id', async (req) => {
    const id = Number(req.params.id);
    if (one('SELECT id FROM users WHERE package_id = ?', id)) throw conflict('Move accounts off this package before deleting it.');
    exec('DELETE FROM packages WHERE id = ?', id);
    audit(actor(req), 'package.delete', String(id), req.ip);
    return { ok: true };
  });

  // ---- Accounts ----
  app.get('/api/admin/accounts', async () => {
    const rows = all<UserRow & { domain: string | null; package_name: string | null; disk_mb: number | null }>(`
      SELECT u.*, d.name AS domain, p.name AS package_name, p.disk_mb
      FROM users u
      LEFT JOIN domains d ON d.user_id = u.id AND d.type = 'main'
      LEFT JOIN packages p ON p.id = u.package_id
      WHERE u.role = 'user' ORDER BY u.username`);
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      email: r.email,
      domain: r.domain,
      status: r.status,
      packageId: r.package_id,
      packageName: r.package_name,
      diskUsedBytes: r.disk_used_bytes,
      diskLimitMb: r.disk_mb,
      createdAt: r.created_at,
    }));
  });

  app.post('/api/admin/accounts', async (req) => {
    const b = (req.body ?? {}) as Body;
    const user = await accounts.createAccount({ username: b.username, password: b.password, email: b.email, domain: b.domain, packageId: b.packageId });
    audit(actor(req), 'account.create', `${user.username} ${String(b.domain)}`, req.ip);
    return publicUser(user);
  });

  app.put<{ Params: { id: string } }>('/api/admin/accounts/:id', async (req) => {
    const id = Number(req.params.id);
    const u = one<UserRow>("SELECT * FROM users WHERE id = ? AND role = 'user'", id);
    if (!u) throw notFound();
    const b = (req.body ?? {}) as Body;
    if (b.email !== undefined) exec('UPDATE users SET email = ? WHERE id = ?', v.email(b.email), id);
    if (b.packageId !== undefined) await accounts.changePackage(id, Number(b.packageId));
    if (b.password) await accounts.setAccountPassword(id, v.password(b.password));
    audit(actor(req), 'account.update', u.username, req.ip);
    return publicUser(one<UserRow>('SELECT * FROM users WHERE id = ?', id)!);
  });

  app.post<{ Params: { id: string } }>('/api/admin/accounts/:id/suspend', async (req) => {
    const id = Number(req.params.id);
    await accounts.setSuspended(id, true);
    audit(actor(req), 'account.suspend', String(id), req.ip);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/admin/accounts/:id/unsuspend', async (req) => {
    const id = Number(req.params.id);
    await accounts.setSuspended(id, false);
    audit(actor(req), 'account.unsuspend', String(id), req.ip);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/admin/accounts/:id', async (req) => {
    const id = Number(req.params.id);
    const u = one<UserRow>("SELECT * FROM users WHERE id = ? AND role = 'user'", id);
    if (!u) throw notFound();
    const b = (req.body ?? {}) as Body;
    if (b.confirm !== u.username) throw badRequest(`Type the username "${u.username}" to confirm.`);
    const problems = await accounts.terminateAccount(id);
    audit(actor(req), 'account.terminate', `${u.username}${problems.length ? ` (with ${problems.length} warnings)` : ''}`, req.ip);
    return { ok: true, problems };
  });

  app.post<{ Params: { id: string } }>('/api/admin/accounts/:id/login-as', async (req, reply) => {
    const admin = requireAdmin(req);
    const id = Number(req.params.id);
    const u = one<UserRow>("SELECT * FROM users WHERE id = ? AND role = 'user'", id);
    if (!u) throw notFound();
    destroySession(reply, req.session!.tokenHash);
    createSession(reply, u.id, req.ip, admin.id);
    audit(admin.username, 'account.login_as', u.username, req.ip);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/admin/accounts/:id/refresh-disk', async (req) => {
    const u = one<UserRow>("SELECT * FROM users WHERE id = ? AND role = 'user'", Number(req.params.id));
    if (!u) throw notFound();
    return { bytes: await accounts.refreshDiskUsage(u) };
  });

  app.get<{ Querystring: { limit?: string } }>('/api/admin/audit', async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 1000);
    return all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', limit);
  });
}
