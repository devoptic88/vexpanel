import { Clock, Database, FolderOpen, Globe, KeyRound, Mail, Network, RefreshCw, ShieldCheck } from 'lucide-react';
import { formatBytes, get, post, type Pkg } from '../../api';
import { ErrorBox, Link, Loading, Module, PageHead, Rail, useAction, useLoad } from '../../components/ui';

interface Overview {
  username: string; domain: string; home: string; serverIp: string; nameservers: string[]; hostname: string; package: Pkg;
  usage: { diskBytes: number; diskCheckedAt: string | null; addon: number; sub: number; databases: number; email: number; cron: number };
}

const TOOLS = [
  { to: '/files', icon: <FolderOpen />, label: 'File manager', hint: 'Upload, edit and organize site files' },
  { to: '/domains', icon: <Globe />, label: 'Domains', hint: 'Addon domains and subdomains' },
  { to: '/ssl', icon: <ShieldCheck />, label: 'SSL certificates', hint: "Free HTTPS from Let's Encrypt" },
  { to: '/databases', icon: <Database />, label: 'Databases', hint: 'MariaDB databases and users' },
  { to: '/email', icon: <Mail />, label: 'Email', hint: 'Mailboxes and forwarders' },
  { to: '/dns', icon: <Network />, label: 'DNS zones', hint: 'A, CNAME, MX, TXT and more' },
  { to: '/cron', icon: <Clock />, label: 'Cron jobs', hint: 'Run commands on a schedule' },
  { to: '/password', icon: <KeyRound />, label: 'Password', hint: 'Panel and SFTP password' },
];

export default function Home() {
  const { data, error, loading, reload } = useLoad(() => get<Overview>('/api/user/overview'));
  const { run, busy } = useAction();
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const p = data.package;
  const u = data.usage;

  return (
    <>
      <PageHead title={data.domain} sub={<>Hosting account <strong>{data.username}</strong> on the {p.name} package</>}>
        <a className="btn" href={`http://${data.domain}`} target="_blank" rel="noreferrer">Visit site</a>
      </PageHead>

      <div className="grid-2 home-grid">
        <Module title="Tools">
          <div className="tools">
            {TOOLS.map((t) => (
              <Link key={t.to} to={t.to} className="tool">
                {t.icon}
                <span>{t.label}<br /><small>{t.hint}</small></span>
              </Link>
            ))}
          </div>
        </Module>

        <div>
          <Module
            title="Usage"
            actions={
              <button className="small ghost" disabled={busy} onClick={() => run(async () => { await post('/api/user/refresh-disk'); await reload(); })} aria-label="Recalculate disk usage">
                <RefreshCw /> {busy ? 'Measuring…' : 'Measure disk'}
              </button>
            }
          >
            <div className="form">
              <Rail label="Disk" used={u.diskBytes} max={p.disk_mb * 1048576} format={formatBytes} bytes />
              <Rail label="Addon domains" used={u.addon} max={p.max_addon_domains} />
              <Rail label="Subdomains" used={u.sub} max={p.max_subdomains} />
              <Rail label="Databases" used={u.databases} max={p.max_databases} />
              <Rail label="Email accounts" used={u.email} max={p.max_email_accounts} />
              <Rail label="Cron jobs" used={u.cron} max={p.max_cron_jobs} />
            </div>
          </Module>
          <Module title="Connection details">
            <dl className="kv">
              <dt>Server IP</dt><dd><code>{data.serverIp}</code></dd>
              <dt>Nameservers</dt><dd>{data.nameservers.map((n) => <div key={n}><code>{n}</code></div>)}</dd>
              <dt>SFTP</dt><dd><code>{data.username}@{data.hostname}</code></dd>
              <dt>Home folder</dt><dd><code>{data.home}</code></dd>
            </dl>
          </Module>
        </div>
      </div>
    </>
  );
}
