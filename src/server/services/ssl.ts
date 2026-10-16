import { config } from '../config.js';
import { exec, one, type DomainRow, type UserRow } from '../db.js';
import { run, serial } from '../sys/exec.js';
import { certPaths, reloadNginx, writeVhost } from './web.js';

/** Issue (or renew) a Let's Encrypt certificate using the HTTP-01 webroot challenge, then switch the vhost to HTTPS. */
export function issueCertificate(domainId: number, includeWww: boolean): Promise<{ expires: string | null }> {
  return serial(async () => {
    const d = one<DomainRow>('SELECT * FROM domains WHERE id = ?', domainId)!;
    const user = one<UserRow>('SELECT * FROM users WHERE id = ?', d.user_id)!;
    const names = [d.name, ...(includeWww && d.type !== 'sub' ? [`www.${d.name}`] : [])];
    await run('certbot', [
      'certonly', '--webroot', '-w', d.docroot,
      '--cert-name', d.name,
      ...names.flatMap((n) => ['-d', n]),
      '--non-interactive', '--agree-tos', '--keep-until-expiring', '--expand',
      '-m', config.adminEmail,
    ], { timeoutMs: 180_000 });

    const expires = await certExpiry(d.name);
    exec('UPDATE domains SET ssl = 1, ssl_expires = ? WHERE id = ?', expires, d.id);
    await writeVhost({ ...d, ssl: 1 }, user);
    await reloadNginx();
    return { expires };
  });
}

export async function certExpiry(domain: string): Promise<string | null> {
  const fallback = new Date(Date.now() + 90 * 86400_000).toISOString();
  const r = await run('openssl', ['x509', '-enddate', '-noout', '-in', certPaths(domain).cert], {
    allowFail: true,
    dryRunResult: { stdout: `notAfter=${new Date(fallback).toUTCString()}` },
  });
  const m = r.stdout.match(/notAfter=(.+)/);
  return m ? new Date(m[1].trim()).toISOString() : null;
}

/** Turn HTTPS off for a domain (the certificate stays on disk). */
export function disableSsl(domainId: number) {
  return serial(async () => {
    const d = one<DomainRow>('SELECT * FROM domains WHERE id = ?', domainId)!;
    const user = one<UserRow>('SELECT * FROM users WHERE id = ?', d.user_id)!;
    exec('UPDATE domains SET ssl = 0 WHERE id = ?', d.id);
    await writeVhost({ ...d, ssl: 0 }, user);
    await reloadNginx();
  });
}

export async function deleteCertificate(domain: string) {
  await run('certbot', ['delete', '--cert-name', domain, '--non-interactive'], { allowFail: true });
}
