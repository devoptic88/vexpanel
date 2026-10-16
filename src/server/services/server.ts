import os from 'node:os';
import { statfs } from 'node:fs/promises';
import { config } from '../config.js';
import { run } from '../sys/exec.js';

export const SERVICES = ['nginx', `php${config.phpVersion}-fpm`, 'mariadb', 'postfix', 'dovecot', 'named'] as const;

export async function serviceStatus(): Promise<Array<{ name: string; active: boolean | null }>> {
  if (config.dryRun) return SERVICES.map((name) => ({ name, active: null }));
  return Promise.all(
    SERVICES.map(async (name) => {
      const r = await run('systemctl', ['is-active', name], { allowFail: true });
      return { name, active: r.stdout.trim() === 'active' };
    }),
  );
}

export async function serverStats() {
  const fsStat = await statfs(config.dryRun ? config.dataDir : config.homeBase).catch(() => null);
  return {
    hostname: config.hostname,
    ip: config.serverIp,
    version: config.version,
    dryRun: config.dryRun,
    uptimeSec: os.uptime(),
    load: os.loadavg(),
    cpus: os.cpus().length,
    memory: { total: os.totalmem(), free: os.freemem() },
    disk: fsStat ? { total: fsStat.blocks * fsStat.bsize, free: fsStat.bavail * fsStat.bsize } : null,
    services: await serviceStatus(),
  };
}
