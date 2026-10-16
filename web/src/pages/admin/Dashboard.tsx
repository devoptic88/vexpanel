import { formatBytes, get } from '../../api';
import { ErrorBox, Link, Loading, Module, PageHead, Rail, useLoad } from '../../components/ui';

interface Stats {
  server: {
    hostname: string; ip: string; version: string; dryRun: boolean; uptimeSec: number; load: number[]; cpus: number;
    memory: { total: number; free: number }; disk: { total: number; free: number } | null;
    services: Array<{ name: string; active: boolean | null }>;
  };
  counts: { accounts: number; suspended: number; domains: number; mailboxes: number; databases: number };
}

function uptime(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return d ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3600) / 60)}m`;
}

export default function Dashboard() {
  const { data, error, loading } = useLoad(() => get<Stats>('/api/admin/stats'));
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const { server: s, counts: c } = data;
  const memUsed = s.memory.total - s.memory.free;

  return (
    <>
      <PageHead title={s.hostname} sub={<>Primary IP <code>{s.ip}</code> · up {uptime(s.uptimeSec)}</>}>
        <Link to="/admin/accounts" className="btn primary">Create an account</Link>
      </PageHead>

      <Module flush>
        <div className="facts">
          <div className="fact"><b>{c.accounts}</b><span>Accounts{c.suspended ? `, ${c.suspended} suspended` : ''}</span></div>
          <div className="fact"><b>{c.domains}</b><span>Domains</span></div>
          <div className="fact"><b>{c.mailboxes}</b><span>Mailboxes</span></div>
          <div className="fact"><b>{c.databases}</b><span>Databases</span></div>
        </div>
      </Module>

      <div className="grid-2" style={{ marginTop: 18 }}>
        <Module title="Resources">
          <div className="form">
            <Rail label={`Load (${s.cpus} CPU)`} used={Number(s.load[0].toFixed(2))} max={s.cpus} format={(n) => n.toFixed(2)} bytes />
            <Rail label="Memory" used={memUsed} max={s.memory.total} format={formatBytes} bytes />
            {s.disk && <Rail label="Disk (/home)" used={s.disk.total - s.disk.free} max={s.disk.total} format={formatBytes} bytes />}
          </div>
        </Module>
        <Module title="Services" sub={s.dryRun ? 'Status checks are skipped in dry-run mode.' : undefined}>
          <dl className="kv">
            {s.services.map((x) => (
              <div key={x.name} style={{ display: 'contents' }}>
                <dt><code>{x.name}</code></dt>
                <dd>
                  <span className={`status ${x.active === null ? '' : x.active ? 'ok' : 'bad'}`}>
                    {x.active === null ? 'Not checked' : x.active ? 'Running' : 'Stopped'}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </Module>
      </div>
    </>
  );
}
