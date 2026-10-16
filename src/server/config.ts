import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

function list(v: string | undefined, fallback: string[]): string[] {
  if (!v) return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

const dataDir = path.resolve(process.env.VEX_DATA_DIR ?? '/var/lib/vexpanel');

export const config = {
  version: pkg.version,
  /** Address the panel's HTTP server binds to. In production nginx terminates TLS in front of it. */
  host: process.env.VEX_HOST ?? '127.0.0.1',
  port: Number(process.env.VEX_PORT ?? 2086),
  dataDir,
  /** When true, no system commands run and every system file is written under <dataDir>/dryroot. */
  dryRun: process.env.VEX_DRY_RUN === '1',
  secureCookies: process.env.VEX_SECURE_COOKIES !== '0',
  serverIp: process.env.VEX_SERVER_IP ?? '127.0.0.1',
  serverIpv6: process.env.VEX_SERVER_IPV6 ?? '',
  /** Emit `listen [::]` in vhosts. Off when the kernel has IPv6 disabled, or nginx would refuse to start. */
  ipv6Listen: process.env.VEX_IPV6 ? process.env.VEX_IPV6 === '1' : existsSync('/proc/net/if_inet6'),
  hostname: process.env.VEX_HOSTNAME ?? os.hostname(),
  nameservers: list(process.env.VEX_NAMESERVERS, ['ns1.example.com', 'ns2.example.com']),
  adminEmail: process.env.VEX_ADMIN_EMAIL ?? 'admin@example.com',
  phpVersion: process.env.VEX_PHP_VERSION ?? '8.3',
  homeBase: '/home',
  vmailBase: '/var/vmail',
  vmailUid: Number(process.env.VEX_VMAIL_UID ?? 5000),
  vmailGid: Number(process.env.VEX_VMAIL_GID ?? 5000),
  mysql: {
    socketPath: process.env.VEX_MYSQL_SOCKET ?? '/run/mysqld/mysqld.sock',
    user: process.env.VEX_MYSQL_USER ?? 'vexpanel',
    password: process.env.VEX_MYSQL_PASSWORD ?? '',
  },
  sessionHours: Number(process.env.VEX_SESSION_HOURS ?? 12),
};

export type Config = typeof config;
