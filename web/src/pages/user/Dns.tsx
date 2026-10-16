import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { del, get, post, put } from '../../api';
import { Empty, ErrorBox, Field, FormModal, Loading, Module, PageHead, useAction, useLoad } from '../../components/ui';
import type { Domain } from './Domains';

interface DnsRecord { id: number; name: string; type: string; value: string; ttl: number; priority: number | null }
const TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA', 'NS'];
const VALUE_HINT: Record<string, string> = {
  A: 'IPv4 address, e.g. 203.0.113.10',
  AAAA: 'IPv6 address',
  CNAME: 'Hostname this name points to, e.g. example.com.',
  MX: 'Mail server hostname, e.g. mail',
  TXT: 'Text, e.g. v=spf1 a mx ~all',
  SRV: 'weight port target, e.g. 5 5060 sip.example.com.',
  CAA: 'flags tag "value", e.g. 0 issue "letsencrypt.org"',
  NS: 'Nameserver hostname',
};

export default function Dns() {
  const domains = useLoad(() => get<Domain[]>('/api/domains'));
  const zones = (domains.data ?? []).filter((d) => d.type !== 'sub').sort((a, b) => (a.type === 'main' ? -1 : b.type === 'main' ? 1 : a.name.localeCompare(b.name)));
  const [zoneId, setZoneId] = useState<number | null>(null);
  useEffect(() => {
    if (zoneId === null && zones.length) setZoneId(zones[0].id);
  }, [zones, zoneId]);

  return (
    <>
      <PageHead title="DNS zones" sub="Records take effect at this server's nameservers right away; resolvers may cache old answers for up to the TTL." />
      {domains.loading && !domains.data ? <Loading /> : domains.error ? <ErrorBox error={domains.error} /> : (
        <>
          <div className="row" style={{ marginBottom: 14 }}>
            <label className="row" htmlFor="zone">Zone</label>
            <select id="zone" style={{ width: 'auto' }} value={zoneId ?? ''} onChange={(e) => setZoneId(Number(e.target.value))}>
              {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>
          </div>
          {zoneId && <Zone id={zoneId} />}
        </>
      )}
    </>
  );
}

function Zone({ id }: { id: number }) {
  const { data, error, loading, reload } = useLoad(() => get<{ zone: string; serial: number; records: DnsRecord[] }>(`/api/dns/${id}`), [id]);
  const [editing, setEditing] = useState<Partial<DnsRecord> | null>(null);
  const { run, busy } = useAction();

  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const fqdn = (n: string) => (n === '@' ? data.zone : `${n}.${data.zone}`);

  return (
    <>
      <Module
        flush
        title={data.zone}
        sub={`Serial ${data.serial}`}
        actions={<button className="primary" onClick={() => setEditing({ type: 'A', name: '', ttl: 3600 })}><Plus /> Add record</button>}
      >
        {data.records.length === 0 ? <Empty title="No records" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Type</th><th>Value</th><th>TTL</th><th /></tr></thead>
              <tbody>
                {data.records.map((r) => (
                  <tr key={r.id}>
                    <td><code>{fqdn(r.name)}</code></td>
                    <td><span className="tag">{r.type}</span></td>
                    <td style={{ overflowWrap: 'anywhere' }}><code>{r.priority != null ? `${r.priority} ` : ''}{r.value}</code></td>
                    <td className="muted">{r.ttl}</td>
                    <td className="actions">
                      <button className="small" onClick={() => setEditing(r)}>Edit</button>
                      <button
                        className="small danger"
                        disabled={busy}
                        onClick={() => confirm(`Delete ${r.type} record for ${fqdn(r.name)}?`) && run(async () => { await del(`/api/dns/${id}/records/${r.id}`); await reload(); }, 'Record deleted')}
                      >Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Module>
      {editing && <RecordModal zoneId={id} zone={data.zone} record={editing} onClose={() => setEditing(null)} onDone={reload} />}
    </>
  );
}

function RecordModal({ zoneId, zone, record, onClose, onDone }: { zoneId: number; zone: string; record: Partial<DnsRecord>; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({
    name: record.name ?? '',
    type: record.type ?? 'A',
    value: record.value ?? '',
    ttl: String(record.ttl ?? 3600),
    priority: record.priority != null ? String(record.priority) : record.type === 'MX' ? '10' : '',
  });
  const hasPriority = f.type === 'MX' || f.type === 'SRV';
  return (
    <FormModal
      title={record.id ? 'Edit record' : 'Add record'}
      submitLabel={record.id ? 'Save record' : 'Add record'}
      onClose={onClose}
      onSubmit={async () => {
        const body = { ...f, priority: hasPriority ? f.priority : undefined };
        if (record.id) await put(`/api/dns/${zoneId}/records/${record.id}`, body);
        else await post(`/api/dns/${zoneId}/records`, body);
        onDone();
      }}
    >
      <div className="form-row">
        <Field label="Name" hint="@ for the domain itself.">
          <div className="prefixed" style={{ flexDirection: 'row-reverse' }}>
            <span style={{ borderRadius: '0 4px 4px 0', borderLeft: 0, borderRight: '1px solid var(--line-strong)' }}>.{zone}</span>
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="@" style={{ borderRadius: '4px 0 0 4px' }} autoFocus />
          </div>
        </Field>
        <Field label="Type">
          <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, priority: e.target.value === 'MX' && !f.priority ? '10' : f.priority })}>
            {TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Value" hint={VALUE_HINT[f.type]}>
        <input value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} className="mono" />
      </Field>
      <div className="form-row">
        {hasPriority && <Field label="Priority"><input type="number" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} /></Field>}
        <Field label="TTL (seconds)"><input type="number" min={60} value={f.ttl} onChange={(e) => setF({ ...f, ttl: e.target.value })} /></Field>
      </div>
    </FormModal>
  );
}
