import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { exec, one } from './db.js';
import { HttpError, SysError } from './errors.js';
import { hashPassword, purgeExpiredSessions, sessionHook } from './auth.js';
import { closeMysql } from './services/mysql.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import userRoutes from './routes/user.js';
import appRoutes from './routes/apps.js';
import { failInterruptedInstalls } from './services/apps.js';

export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.VEX_LOG_LEVEL ?? 'info' },
    trustProxy: config.host === '127.0.0.1' || config.host === '::1',
    bodyLimit: 4 * 1024 * 1024,
  });

  // Accept an empty body on JSON requests (e.g. POST /suspend with no payload).
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error('Request body is not valid JSON.'), { statusCode: 400 }), undefined);
    }
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { fileSize: 512 * 1024 * 1024, files: 20 } });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-frame-options', 'DENY');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
  });
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/api/')) await sessionHook(req);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof SysError) {
      req.log.error({ detail: err.detail }, err.message);
      // Admins get the underlying command output; account holders get a generic message.
      const isAdmin = req.session?.user.role === 'admin' || req.session?.impersonatedBy;
      return reply.status(500).send({ error: err.message, detail: isAdmin ? err.detail : undefined });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
    req.log.error(err);
    return reply.status(500).send({ error: 'Something went wrong on the server.' });
  });

  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(userRoutes);
  await app.register(appRoutes);

  app.get('/api/health', async () => ({ ok: true, version: config.version, dryRun: config.dryRun }));

  const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
  if (existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}

/** Create the first admin with a random password if none exists. */
async function bootstrapAdmin() {
  if (one("SELECT id FROM users WHERE role = 'admin'")) return;
  const pw = process.env.VEX_ADMIN_PASSWORD || randomBytes(12).toString('base64url');
  exec("INSERT INTO users (username, password_hash, role, email) VALUES ('admin', ?, 'admin', ?)", await hashPassword(pw), config.adminEmail);
  const file = path.join(config.dataDir, 'initial-admin.txt');
  writeFileSync(file, `username: admin\npassword: ${pw}\n`, { mode: 0o600 });
  console.log(`\n  VEXPANEL first admin created → username "admin", password saved to ${file}\n`);
}

async function main() {
  if (!config.dryRun && process.getuid?.() !== 0) {
    console.error('VEXPANEL manages system services and must run as root. For local development set VEX_DRY_RUN=1.');
    process.exit(1);
  }
  await bootstrapAdmin();
  purgeExpiredSessions();
  failInterruptedInstalls();
  setInterval(purgeExpiredSessions, 3600_000).unref();

  const app = await buildApp();
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`VEXPANEL ${config.version} listening on ${config.host}:${config.port}${config.dryRun ? ' (DRY RUN)' : ''}`);

  const stop = async () => {
    await app.close();
    await closeMysql();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
