import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { all } from '../db.js';
import { run, serial } from '../sys/exec.js';
import { removePath, writeAtomic } from '../sys/fsx.js';

export const POSTFIX_DIR = '/etc/postfix/vexpanel';
export const DOVECOT_USERS = '/etc/dovecot/vexpanel-users';

/** Dovecot {SSHA512} scheme: base64(sha512(password + salt) + salt). */
export function dovecotHash(password: string): string {
  const salt = randomBytes(16);
  const digest = createHash('sha512').update(Buffer.concat([Buffer.from(password, 'utf8'), salt])).digest();
  return `{SSHA512}${Buffer.concat([digest, salt]).toString('base64')}`;
}

export function verifyDovecotHash(password: string, stored: string): boolean {
  const raw = Buffer.from(stored.replace(/^\{SSHA512\}/, ''), 'base64');
  const salt = raw.subarray(64);
  const digest = createHash('sha512').update(Buffer.concat([Buffer.from(password, 'utf8'), salt])).digest();
  return digest.equals(raw.subarray(0, 64));
}

interface MailboxRow {
  local_part: string;
  domain: string;
  password_hash: string;
  quota_mb: number;
  status: string;
}

/** Render all Postfix maps and the Dovecot passwd-file from the database. Pure, unit-tested. */
export function renderMailMaps(
  domains: string[],
  boxes: MailboxRow[],
  forwards: Array<{ local_part: string; domain: string; destination: string }>,
) {
  const vdomains = domains.map((d) => `${d} OK`).join('\n') + '\n';
  const vmailbox = boxes.map((b) => `${b.local_part}@${b.domain} ${b.domain}/${b.local_part}/`).join('\n') + '\n';

  // Group forwarders by source. A source that also has a mailbox keeps a copy locally.
  const byAddr = new Map<string, string[]>();
  for (const f of forwards) {
    const k = `${f.local_part}@${f.domain}`;
    byAddr.set(k, [...(byAddr.get(k) ?? []), f.destination]);
  }
  const mailboxSet = new Set(boxes.map((b) => `${b.local_part}@${b.domain}`));
  const valias =
    [...byAddr.entries()].map(([src, dests]) => `${src} ${(mailboxSet.has(src) ? [src, ...dests] : dests).join(',')}`).join('\n') + '\n';

  const users =
    boxes
      .map((b) => {
        // Suspended accounts keep receiving mail but cannot log in to read it.
        const pass = b.status === 'suspended' ? '!' : b.password_hash;
        return `${b.local_part}@${b.domain}:${pass}:${config.vmailUid}:${config.vmailGid}::${config.vmailBase}/${b.domain}/${b.local_part}::userdb_quota_rule=*:storage=${b.quota_mb}M`;
      })
      .join('\n') + '\n';

  return { vdomains, vmailbox, valias, users };
}

/** Regenerate every mail map from the database and reload Postfix/Dovecot. */
export function applyMail(): Promise<void> {
  return serial(async () => {
    const domains = all<{ name: string }>("SELECT name FROM domains WHERE type IN ('main','addon') ORDER BY name").map((d) => d.name);
    const boxes = all<MailboxRow>(
      `SELECT m.local_part, d.name AS domain, m.password_hash, m.quota_mb, u.status
       FROM mail_accounts m JOIN domains d ON d.id = m.domain_id JOIN users u ON u.id = m.user_id
       ORDER BY d.name, m.local_part`,
    );
    const forwards = all<{ local_part: string; domain: string; destination: string }>(
      `SELECT f.local_part, d.name AS domain, f.destination
       FROM mail_forwarders f JOIN domains d ON d.id = f.domain_id ORDER BY d.name, f.local_part`,
    );
    const m = renderMailMaps(domains, boxes, forwards);
    await writeAtomic(`${POSTFIX_DIR}/vdomains`, m.vdomains);
    await writeAtomic(`${POSTFIX_DIR}/vmailbox`, m.vmailbox);
    await writeAtomic(`${POSTFIX_DIR}/valias`, m.valias);
    // Contains password hashes: readable only by root and the dovecot group.
    await writeAtomic(DOVECOT_USERS, m.users, 0o640);
    await run('chgrp', ['dovecot', DOVECOT_USERS]);
    for (const f of ['vdomains', 'vmailbox', 'valias']) await run('postmap', [`${POSTFIX_DIR}/${f}`]);
    await run('systemctl', ['reload', 'postfix']);
  });
}

export async function removeMailboxDir(domain: string, local?: string) {
  await removePath(local ? `${config.vmailBase}/${domain}/${local}` : `${config.vmailBase}/${domain}`);
}
