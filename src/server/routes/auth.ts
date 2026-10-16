import type { FastifyInstance } from 'fastify';
import { actor, checkLogin, createSession, destroySession, requireUser, verifyPassword } from '../auth.js';
import { audit, exec, one, type PackageRow, type UserRow } from '../db.js';
import { HttpError, badRequest } from '../errors.js';
import { setAccountPassword } from '../services/accounts.js';
import * as v from '../validate.js';

type Body = Record<string, unknown>;

export function publicUser(u: UserRow) {
  const pkg = u.package_id ? one<PackageRow>('SELECT * FROM packages WHERE id = ?', u.package_id) : null;
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    email: u.email,
    status: u.status,
    package: pkg,
    diskUsedBytes: u.disk_used_bytes,
    createdAt: u.created_at,
  };
}

export default async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = (req.body ?? {}) as Body;
    const username = String(b.username ?? '').trim().toLowerCase();
    const user = await checkLogin(username, String(b.password ?? ''));
    if (!user) {
      audit(username || '?', 'login.failed', '', req.ip);
      throw new HttpError(401, 'Wrong username or password.');
    }
    if (user.status === 'suspended') throw new HttpError(423, 'This account is suspended. Contact your host.');
    createSession(reply, user.id, req.ip);
    audit(user.username, 'login', '', req.ip);
    return { user: publicUser(user) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    destroySession(reply, req.session?.tokenHash);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    if (!req.session) return { user: null };
    const s = req.session;
    const admin = s.impersonatedBy ? one<UserRow>('SELECT * FROM users WHERE id = ?', s.impersonatedBy) : null;
    return { user: publicUser(s.user), impersonatedBy: admin?.username ?? null, csrf: s.csrf };
  });

  /** Leave a "log in as" session and go back to the admin account. */
  app.post('/api/auth/return', async (req, reply) => {
    const s = req.session;
    if (!s?.impersonatedBy) throw badRequest('Not impersonating anyone.');
    const adminId = s.impersonatedBy;
    destroySession(reply, s.tokenHash);
    createSession(reply, adminId, req.ip);
    return { ok: true };
  });

  app.post('/api/auth/password', async (req) => {
    const u = requireUser(req);
    if (req.session!.impersonatedBy) throw badRequest('Change the account password from the admin side.');
    const b = (req.body ?? {}) as Body;
    if (!(await verifyPassword(String(b.current ?? ''), u.password_hash))) throw badRequest('Current password is wrong.');
    const next = v.password(b.next);
    await setAccountPassword(u.id, next);
    exec('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', u.id, req.session!.tokenHash);
    audit(actor(req), 'password.change', '', req.ip);
    return { ok: true };
  });
}
