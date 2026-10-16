import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { exec, one, type UserRow } from './db.js';
import { HttpError } from './errors.js';

export const SESSION_COOKIE = 'vex_session';
export const CSRF_COOKIE = 'vex_csrf';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 12);
}

export function verifyPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}

// A real hash to compare against when the username doesn't exist, so timing doesn't reveal valid names.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);
export async function checkLogin(username: string, pw: string): Promise<UserRow | null> {
  const user = one<UserRow>('SELECT * FROM users WHERE username = ?', username);
  const ok = await verifyPassword(pw, user?.password_hash ?? DUMMY_HASH);
  return user && ok ? user : null;
}

export interface Session {
  user: UserRow;
  csrf: string;
  impersonatedBy: number | null;
  tokenHash: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    session?: Session;
  }
}

export function createSession(reply: FastifyReply, userId: number, ip: string, impersonatedBy: number | null = null) {
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(24).toString('base64url');
  const expires = Date.now() + config.sessionHours * 3600_000;
  exec(
    'INSERT INTO sessions (token_hash, user_id, csrf, impersonated_by, expires_at, ip) VALUES (?, ?, ?, ?, ?, ?)',
    sha256(token),
    userId,
    csrf,
    impersonatedBy,
    expires,
    ip,
  );
  const base = { path: '/', sameSite: 'strict' as const, secure: config.secureCookies, maxAge: config.sessionHours * 3600 };
  reply.setCookie(SESSION_COOKIE, token, { ...base, httpOnly: true });
  reply.setCookie(CSRF_COOKIE, csrf, { ...base, httpOnly: false });
}

export function destroySession(reply: FastifyReply, tokenHash?: string) {
  if (tokenHash) exec('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  reply.clearCookie(CSRF_COOKIE, { path: '/' });
}

export function destroyUserSessions(userId: number) {
  exec('DELETE FROM sessions WHERE user_id = ?', userId);
}

/** Populate request.session from the cookie, and enforce CSRF on state-changing requests. */
export async function sessionHook(req: FastifyRequest) {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return;
  const hash = sha256(token);
  const row = one<{ user_id: number; csrf: string; impersonated_by: number | null; expires_at: number }>(
    'SELECT user_id, csrf, impersonated_by, expires_at FROM sessions WHERE token_hash = ?',
    hash,
  );
  if (!row || row.expires_at < Date.now()) {
    if (row) exec('DELETE FROM sessions WHERE token_hash = ?', hash);
    return;
  }
  const user = one<UserRow>('SELECT * FROM users WHERE id = ?', row.user_id);
  if (!user) return;
  req.session = { user, csrf: row.csrf, impersonatedBy: row.impersonated_by, tokenHash: hash };

  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const header = String(req.headers['x-csrf-token'] ?? '');
    const a = Buffer.from(header);
    const b = Buffer.from(row.csrf);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(403, 'CSRF token missing or invalid. Reload the page.');
  }
}

export function requireUser(req: FastifyRequest): UserRow {
  if (!req.session) throw new HttpError(401, 'Not signed in.');
  return req.session.user;
}

export function requireAdmin(req: FastifyRequest): UserRow {
  const u = requireUser(req);
  if (u.role !== 'admin') throw new HttpError(403, 'Administrator access required.');
  return u;
}

/** A hosting account holder. Suspended accounts can sign in and see their data but cannot change anything. */
export function requireAccount(req: FastifyRequest, opts: { write?: boolean } = {}): UserRow {
  const u = requireUser(req);
  if (u.role !== 'user') throw new HttpError(403, 'This page is for hosting accounts. Use "Log in as" from the admin side.');
  if (opts.write && u.status === 'suspended') throw new HttpError(423, 'This account is suspended.');
  return u;
}

export function purgeExpiredSessions() {
  exec('DELETE FROM sessions WHERE expires_at < ?', Date.now());
}

export function actor(req: FastifyRequest): string {
  const s = req.session;
  if (!s) return 'anonymous';
  if (s.impersonatedBy) {
    const admin = one<{ username: string }>('SELECT username FROM users WHERE id = ?', s.impersonatedBy);
    return `${admin?.username ?? 'admin'} (as ${s.user.username})`;
  }
  return s.user.username;
}
