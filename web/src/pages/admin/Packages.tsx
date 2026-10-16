import { useState } from 'react';
import { Plus } from 'lucide-react';
import { del, formatBytes, get, post, put, type Pkg } from '../../api';
import { Empty, ErrorBox, Field, FormModal, Loading, Module, PageHead, useAction, useLoad } from '../../components/ui';

const LIMITS: Array<[keyof Pkg, string]> = [
  ['max_addon_domains', 'Addon domains'],
  ['max_subdomains', 'Subdomains'],
  ['max_databases', 'Databases'],
  ['max_email_accounts', 'Email accounts'],
  ['max_cron_jobs', 'Cron jobs'],
];

const blank: Omit<Pkg, 'id'> = { name: '', disk_mb: 2048, max_addon_domains: 0, max_subdomains: 10, max_databases: 5, max_email_accounts: 10, max_cron_jobs: 5 };

export default function Packages() {
  const list = useLoad(() => get<Pkg[]>('/api/admin/packages'));
  const [editing, setEditing] = useState<Partial<Pkg> | null>(null);
  const { run } = useAction();

  return (
    <>
      <PageHead title="Packages" sub="Limits applied to each account. Disk limits are enforced with filesystem quotas when they're enabled.">
        <button className="primary" onClick={() => setEditing({ ...blank })}><Plus /> New package</button>
      </PageHead>
      <Module flush>
        {list.loading && !list.data ? <Loading /> : list.error ? <div className="module-body"><ErrorBox error={list.error} /></div> : !list.data?.length ? (
          <Empty title="No packages">Create a package before creating accounts.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Name</th><th>Disk</th>{LIMITS.map(([, l]) => <th key={l}>{l}</th>)}<th>Accounts</th><th /></tr>
              </thead>
              <tbody>
                {list.data.map((p) => (
                  <tr key={p.id}>
                    <td><strong>{p.name}</strong></td>
                    <td>{formatBytes(p.disk_mb * 1048576)}</td>
                    {LIMITS.map(([k]) => <td key={k}>{Number(p[k]) >= 1000 ? 'Unlimited' : p[k]}</td>)}
                    <td>{p.accounts}</td>
                    <td className="actions">
                      <button className="small" onClick={() => setEditing(p)}>Edit</button>
                      <button
                        className="small danger"
                        disabled={!!p.accounts}
                        title={p.accounts ? 'Move accounts off this package first' : undefined}
                        onClick={() => confirm(`Delete package ${p.name}?`) && run(async () => { await del(`/api/admin/packages/${p.id}`); await list.reload(); }, 'Package deleted')}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Module>
      {editing && <EditPackage pkg={editing} onClose={() => setEditing(null)} onDone={list.reload} />}
    </>
  );
}

function EditPackage({ pkg, onClose, onDone }: { pkg: Partial<Pkg>; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState(pkg);
  const num = (k: keyof Pkg) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value === '' ? '' : Number(e.target.value) });
  return (
    <FormModal
      title={pkg.id ? `Edit ${pkg.name}` : 'New package'}
      submitLabel={pkg.id ? 'Save package' : 'Create package'}
      onClose={onClose}
      onSubmit={async () => {
        if (pkg.id) await put(`/api/admin/packages/${pkg.id}`, f);
        else await post('/api/admin/packages', f);
        onDone();
      }}
    >
      <div className="form-row">
        <Field label="Name"><input value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
        <Field label="Disk (MB)"><input type="number" min={100} value={f.disk_mb ?? ''} onChange={num('disk_mb')} /></Field>
      </div>
      <div className="form-row">
        {LIMITS.map(([k, l]) => (
          <Field key={k} label={l}><input type="number" min={0} value={(f[k] as number) ?? ''} onChange={num(k)} /></Field>
        ))}
      </div>
      <p className="muted" style={{ fontSize: '0.86rem' }}>Use 1000 or more to show a limit as unlimited.</p>
    </FormModal>
  );
}
