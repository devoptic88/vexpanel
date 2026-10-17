import type { FastifyInstance, FastifyRequest } from 'fastify';
import { actor, requireAccount } from '../auth.js';
import { audit } from '../db.js';
import { catalog } from '../apps/catalog.js';
import { listInstalls, locationsFor, removeInstall, startInstall, type InstallInput } from '../services/apps.js';

export default async function appRoutes(app: FastifyInstance) {
  const log = (req: FastifyRequest, action: string, detail = '') => audit(actor(req), action, detail, req.ip);

  app.get('/api/apps', async (req) => {
    const u = requireAccount(req);
    return {
      email: u.email,
      catalog: catalog().map(({ source, ...a }) => ({ ...a, upload: source.type === 'upload' })),
      locations: locationsFor(u).map(({ id, label, baseUrl }) => ({ id, label, baseUrl })),
      installs: listInstalls(u.id).map((r) => ({
        id: r.id,
        appId: r.app_id,
        version: r.version,
        path: r.path,
        url: r.url,
        status: r.status,
        message: r.message,
        setupUrl: r.setup_url,
        adminUrl: r.admin_url,
        database: r.db_name ? { name: r.db_name, user: r.db_name, password: r.db_password, host: 'localhost' } : null,
        createdAt: r.created_at,
      })),
    };
  });

  app.post('/api/apps/install', async (req) => {
    const u = requireAccount(req, { write: true });
    const b = (req.body ?? {}) as InstallInput;
    const id = startInstall(u, b);
    log(req, 'app.install_start', String(b.appId));
    return { ok: true, id };
  });

  app.post<{ Params: { id: string } }>('/api/apps/:id/remove', async (req) => {
    const u = requireAccount(req, { write: true });
    const b = (req.body ?? {}) as { dropDatabase?: boolean };
    await removeInstall(u, Number(req.params.id), b.dropDatabase !== false);
    return { ok: true };
  });
}
