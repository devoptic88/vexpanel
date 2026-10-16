import { config } from '../config.js';
import { all, exec, one, type DnsRecordRow, type DomainRow } from '../db.js';
import { run } from '../sys/exec.js';
import { ensureDir, removePath, writeAtomic, writeChecked } from '../sys/fsx.js';

export const BIND_DIR = '/etc/bind/vexpanel';
export const BIND_INDEX = '/etc/bind/named.conf.vexpanel';
const zonePath = (zone: string) => `${BIND_DIR}/db.${zone}`;

/** YYYYMMDDnn, always strictly greater than the previous serial. */
export function nextSerial(prev: number, now = new Date()): number {
  const base = Number(`${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}00`);
  return prev >= base ? prev + 1 : base;
}

/** Default records for a new zone. */
export function defaultRecords(): Array<Omit<DnsRecordRow, 'id' | 'domain_id'>> {
  const r: Array<Omit<DnsRecordRow, 'id' | 'domain_id'>> = [
    ...config.nameservers.map((ns) => ({ name: '@', type: 'NS', value: `${ns}.`, ttl: 86400, priority: null })),
    { name: '@', type: 'A', value: config.serverIp, ttl: 3600, priority: null },
    { name: 'www', type: 'CNAME', value: '@', ttl: 3600, priority: null },
    { name: 'mail', type: 'A', value: config.serverIp, ttl: 3600, priority: null },
    { name: '@', type: 'MX', value: 'mail', ttl: 3600, priority: 10 },
    { name: '@', type: 'TXT', value: 'v=spf1 a mx ~all', ttl: 3600, priority: null },
    { name: '_dmarc', type: 'TXT', value: 'v=DMARC1; p=none', ttl: 3600, priority: null },
  ];
  if (config.serverIpv6) {
    r.push({ name: '@', type: 'AAAA', value: config.serverIpv6, ttl: 3600, priority: null });
    r.push({ name: 'mail', type: 'AAAA', value: config.serverIpv6, ttl: 3600, priority: null });
  }
  return r;
}

export function seedZone(domainId: number) {
  for (const r of defaultRecords()) {
    exec('INSERT INTO dns_records (domain_id, name, type, value, ttl, priority) VALUES (?, ?, ?, ?, ?, ?)', domainId, r.name, r.type, r.value, r.ttl, r.priority);
  }
}

/** Fully-qualify a target if it looks like an absolute host; leave relative names alone. */
function target(v: string): string {
  if (v === '@') return '@';
  return v.endsWith('.') || !v.includes('.') ? v : `${v}.`;
}

/** Render a BIND zone file. Pure function, unit-tested. */
export function renderZone(zone: string, serial: number, records: Array<Omit<DnsRecordRow, 'id' | 'domain_id'>>): string {
  const primaryNs = config.nameservers[0] ?? `ns1.${zone}`;
  const hostmaster = config.adminEmail.replace('@', '.');
  const lines = [
    `; Managed by VEXPANEL — edit records in the panel, not here.`,
    `$ORIGIN ${zone}.`,
    `$TTL 3600`,
    `@ IN SOA ${primaryNs}. ${hostmaster}. ( ${serial} 3600 900 1209600 300 )`,
  ];
  for (const r of records) {
    let value: string;
    switch (r.type) {
      case 'TXT': {
        // Split long strings into 255-byte chunks as BIND requires.
        const chunks = r.value.match(/.{1,255}/g) ?? [''];
        value = chunks.map((c) => `"${c}"`).join(' ');
        break;
      }
      case 'MX':
        value = `${r.priority ?? 10} ${target(r.value)}`;
        break;
      case 'SRV': {
        const [w, port, host] = r.value.split(' ');
        value = `${r.priority ?? 0} ${w} ${port} ${target(host)}`;
        break;
      }
      case 'CNAME':
      case 'NS':
        value = target(r.value);
        break;
      default:
        value = r.value;
    }
    lines.push(`${r.name} ${r.ttl} IN ${r.type} ${value}`);
  }
  return lines.join('\n') + '\n';
}

async function reloadBind() {
  await run('rndc', ['reload'], { allowFail: true }).then(async (r) => {
    if (r.code !== 0) await run('systemctl', ['reload', 'named']);
  });
}

/** Rewrite the include file listing every zone we host. */
async function writeIndex() {
  const zones = all<{ name: string }>("SELECT name FROM domains WHERE type IN ('main','addon') ORDER BY name");
  const body =
    '// Managed by VEXPANEL\n' +
    zones.map((z) => `zone "${z.name}" { type master; file "${zonePath(z.name)}"; allow-transfer { none; }; };`).join('\n') +
    '\n';
  await writeAtomic(BIND_INDEX, body);
}

/** Bump the serial, write the zone, validate with named-checkzone, reload. */
export async function applyZone(domainId: number) {
  const d = one<DomainRow>('SELECT * FROM domains WHERE id = ?', domainId);
  if (!d || d.type === 'sub') return;
  const serial = nextSerial(d.dns_serial);
  exec('UPDATE domains SET dns_serial = ? WHERE id = ?', serial, d.id);
  const records = all<DnsRecordRow>('SELECT * FROM dns_records WHERE domain_id = ? ORDER BY type, name, id', d.id);
  await ensureDir(BIND_DIR);
  await writeChecked(zonePath(d.name), renderZone(d.name, serial, records), async () => {
    await run('named-checkzone', ['-q', d.name, zonePath(d.name)]);
  });
  await writeIndex();
  await reloadBind();
}

export async function removeZone(zone: string) {
  await removePath(zonePath(zone));
  await writeIndex();
  await reloadBind();
}

/** The zone that holds a domain's records: itself for main/addon, its parent for a subdomain. */
export function zoneFor(d: DomainRow): DomainRow {
  if (d.type !== 'sub') return d;
  return one<DomainRow>('SELECT * FROM domains WHERE id = ?', d.parent_id)!;
}
