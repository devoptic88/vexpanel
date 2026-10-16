import { badRequest } from './errors.js';

const RESERVED_USERS = new Set([
  'root', 'admin', 'administrator', 'daemon', 'bin', 'sys', 'sync', 'games', 'man', 'lp', 'mail',
  'news', 'uucp', 'proxy', 'backup', 'list', 'irc', 'nobody', 'systemd', 'www', 'wwwdata', 'mysql',
  'postfix', 'dovecot', 'bind', 'named', 'vmail', 'ubuntu', 'sshd', 'ftp', 'test', 'vexpanel',
  'nginx', 'php', 'cpanel', 'whm', 'postmaster', 'abuse', 'hostmaster', 'webmaster', 'mailer',
]);

export function username(v: unknown): string {
  const s = String(v ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9]{2,15}$/.test(s)) {
    throw badRequest('Username must be 3–16 characters: lowercase letters and digits, starting with a letter.');
  }
  if (RESERVED_USERS.has(s)) throw badRequest(`"${s}" is a reserved name.`);
  return s;
}

export function password(v: unknown, min = 10): string {
  const s = String(v ?? '');
  if (s.length < min) throw badRequest(`Password must be at least ${min} characters.`);
  if (s.length > 128) throw badRequest('Password is too long.');
  if (/[\r\n\0:]/.test(s)) throw badRequest('Password contains a character that is not allowed (newline or colon).');
  return s;
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export function domain(v: unknown): string {
  const s = String(v ?? '').trim().toLowerCase().replace(/\.$/, '');
  const labels = s.split('.');
  if (s.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels.at(-1)!)) {
    throw badRequest(`"${s}" is not a valid domain name.`);
  }
  return s;
}

export function subLabel(v: unknown): string {
  const s = String(v ?? '').trim().toLowerCase();
  if (!LABEL.test(s) || s === 'www' || s === 'mail') throw badRequest(`"${s}" is not a valid subdomain label.`);
  return s;
}

export function email(v: unknown): string {
  const s = String(v ?? '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at < 1 || !/^[a-z0-9._%+-]{1,64}$/.test(s.slice(0, at))) throw badRequest(`"${s}" is not a valid email address.`);
  domain(s.slice(at + 1));
  return s;
}

export function mailLocal(v: unknown): string {
  const s = String(v ?? '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/.test(s) || s.includes('..')) {
    throw badRequest('Mailbox name may use letters, digits, dot, dash, underscore and plus.');
  }
  return s;
}

/** Suffix for database / database-user names; full name becomes `${username}_${suffix}`. */
export function dbSuffix(v: unknown, owner: string, maxTotal: number): string {
  const s = String(v ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_]{1,32}$/.test(s)) throw badRequest('Name may use lowercase letters, digits and underscore.');
  const full = `${owner}_${s}`;
  if (full.length > maxTotal) throw badRequest(`Full name "${full}" is longer than ${maxTotal} characters.`);
  return full;
}

/** Relative path inside a home directory, no traversal. Returns path without leading slash. */
export function relPath(v: unknown): string {
  const s = String(v ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (s.split('/').some((p) => p === '..' || p === '.') || s.includes('\0')) throw badRequest('Invalid path.');
  return s;
}

export function int(v: unknown, name: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${name} must be a whole number between ${min} and ${max}.`);
  return n;
}

const CRON_FIELD = /^(\*|\d{1,2}(-\d{1,2})?)(\/\d{1,2})?(,(\*|\d{1,2}(-\d{1,2})?)(\/\d{1,2})?)*$/;
const CRON_NAMED = /^[a-z]{3}(-[a-z]{3})?(,[a-z]{3}(-[a-z]{3})?)*$/i;
const CRON_MACROS = new Set(['@reboot', '@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly']);

export function cronSchedule(v: unknown): string {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (CRON_MACROS.has(s)) return s;
  const f = s.split(' ');
  const ok = f.length === 5 && f.every((x, i) => CRON_FIELD.test(x) || (i >= 3 && CRON_NAMED.test(x)));
  if (!ok) throw badRequest('Schedule must be five cron fields (e.g. "*/15 * * * *") or a macro like @daily.');
  return s;
}

export function cronCommand(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s || s.length > 1000 || /[\r\n\0]/.test(s)) throw badRequest('Command must be a single line under 1000 characters.');
  return s;
}

export const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA', 'NS'] as const;
export type DnsType = (typeof DNS_TYPES)[number];

/** Record name relative to zone: "@", "www", "_dmarc", "*.dev". */
export function dnsName(v: unknown): string {
  const s = String(v ?? '').trim().toLowerCase().replace(/\.$/, '') || '@';
  if (s === '@') return s;
  const ok = s.split('.').every((l, i) => (i === 0 && l === '*') || /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/.test(l));
  if (!ok || s.length > 200) throw badRequest(`"${s}" is not a valid record name.`);
  return s;
}

export function dnsRecord(input: { name?: unknown; type?: unknown; value?: unknown; ttl?: unknown; priority?: unknown }) {
  const type = String(input.type ?? '').toUpperCase() as DnsType;
  if (!DNS_TYPES.includes(type)) throw badRequest(`Record type must be one of ${DNS_TYPES.join(', ')}.`);
  const name = dnsName(input.name);
  const ttl = input.ttl === undefined || input.ttl === '' ? 3600 : int(input.ttl, 'TTL', 60, 604800);
  let value = String(input.value ?? '').trim();
  let priority: number | null = null;
  if (!value || value.length > 2048 || /[\r\n\0]/.test(value)) throw badRequest('Record value is required and must be one line.');

  const host = (h: string) => {
    const x = h.replace(/\.$/, '');
    if (x !== '@' && !x.split('.').every((l) => /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/i.test(l))) throw badRequest(`"${h}" is not a valid hostname.`);
  };

  switch (type) {
    case 'A':
      if (!/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(value)) throw badRequest('A record needs an IPv4 address.');
      break;
    case 'AAAA':
      if (!/^[0-9a-f:]+$/i.test(value) || !value.includes(':')) throw badRequest('AAAA record needs an IPv6 address.');
      break;
    case 'CNAME':
    case 'NS':
      host(value);
      break;
    case 'MX':
      host(value);
      priority = input.priority === undefined || input.priority === '' ? 10 : int(input.priority, 'Priority', 0, 65535);
      break;
    case 'SRV': {
      // value: "weight port target", priority separate
      priority = int(input.priority ?? 0, 'Priority', 0, 65535);
      const parts = value.split(/\s+/);
      if (parts.length !== 3) throw badRequest('SRV value must be "weight port target".');
      int(parts[0], 'Weight', 0, 65535);
      int(parts[1], 'Port', 0, 65535);
      host(parts[2]);
      value = parts.join(' ');
      break;
    }
    case 'TXT':
      value = value.replace(/^"|"$/g, '');
      if (value.includes('"')) throw badRequest('TXT value may not contain double quotes.');
      break;
    case 'CAA':
      if (!/^\d{1,3} (issue|issuewild|iodef) "[^"]+"$/.test(value)) throw badRequest('CAA value must look like: 0 issue "letsencrypt.org"');
      break;
  }
  return { name, type, value, ttl, priority };
}
