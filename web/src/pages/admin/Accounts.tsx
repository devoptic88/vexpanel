import { useState } from 'react';
import { LogIn, MoreHorizontal, Plus } from 'lucide-react';
import { del, formatBytes, get, post, put, type Pkg } from '../../api';
import { Empty, ErrorBox, Field, FormModal, Loading, Module, PageHead, PasswordInput, navigate, useAction, useLoad } from '../../components/ui';

interface Account {
  id: number; username: string; email: string; domain: string | null; status: 'active' | 'suspended';
  packageId: number; packageName: string; diskUsedBytes: number; diskLimitMb: number; createdAt: string;
}

export default function Accounts() {
  const list = useLoad(() => get<Account[]>('/api/admin/accounts'));
  const pkgs = useLoad(() => get<Pkg[]>('/api/admin/packages'));
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [terminating, setTerminating] = useState<Account | null>(null);
  const [filter, setFilter] = useState('');
  const { run, busy } = useAction();

  const rows = (list.data ?? []).filter((a) => !filter || `${a.username} ${a.domain} ${a.email}`.includes(filter.toLowerCase()));

  return (
    <>
      <PageHead title="Accounts" sub="Each account gets a Linux user, a home folder, its own PHP process pool, a DNS zone and mail for its domain.">
        <button className="primary" onClick={() => setCreating(true)}><Plus /> Create account</button>
      </PageHead>

      <Module
        flush
        title={`${list.data?.length ?? 0} accounts`}
        actions={<input placeholder="Filter by user, domain or email" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 260 }} />}
      >
        {list.loading && !list.data ? <Loading /> : list.error ? <div className="module-body"><ErrorBox error={list.error} /></div> : rows.length === 0 ? (
          <Empty title={filter ? 'No matches' : 'No accounts yet'}>{!filter && 'Create the first hosting account to put a site on this server.'}</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>User</th><th>Domain</th><th>Package</th><th>Disk</th><th>Status</th><th /></tr></thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td><strong>{a.username}</strong><br /><span className="muted">{a.email}</span></td>
                    <td>{a.domain ? <a href={`http://${a.domain}`} target="_blank" rel="noreferrer">{a.domain}</a> : '—'}</td>
                    <td>{a.packageName}</td>
                    <td className="muted">{formatBytes(a.diskUsedBytes)} / {formatBytes(a.diskLimitMb * 1024 * 1024)}</td>
                    <td><span className={`status ${a.status === 'active' ? 'ok' : 'warn'}`}>{a.status === 'active' ? 'Active' : 'Suspended'}</span></td>
                    <td className="actions">
                      <button className="small" disabled={busy} onClick={() => run(async () => { await post(`/api/admin/accounts/${a.id}/login-as`); navigate('/'); location.reload(); })}>
                        <LogIn /> Log in as
                      </button>
                      <button className="small" onClick={() => setEditing(a)} aria-label={`Manage ${a.username}`}><MoreHorizontal /> Manage</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Module>

      {creating && <CreateAccount pkgs={pkgs.data ?? []} onClose={() => setCreating(false)} onDone={list.reload} />}
      {editing && (
        <ManageAccount
          account={editing}
          pkgs={pkgs.data ?? []}
          onClose={() => setEditing(null)}
          onDone={list.reload}
          onTerminate={() => { setTerminating(editing); setEditing(null); }}
        />
      )}
      {terminating && (
        <Terminate account={terminating} onClose={() => setTerminating(null)} onDone={list.reload} />
      )}
    </>
  );
}

function CreateAccount({ pkgs, onClose, onDone }: { pkgs: Pkg[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ domain: '', username: '', email: '', password: '', packageId: pkgs[0]?.id ?? 0 });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  // Suggest a username from the domain, the way most hosts do.
  const suggest = (domain: string) => domain.toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9]/g, '').replace(/^\d+/, '').slice(0, 8);

  return (
    <FormModal
      title="Create account"
      submitLabel="Create account"
      onClose={onClose}
      onSubmit={async () => { await post('/api/admin/accounts', { ...f, packageId: Number(f.packageId) }); onDone(); }}
    >
      <Field label="Domain" hint="The account's main website. No domain yet? Use a placeholder like mysite.test; the site also works at http://server-ip/~username/.">
        <input value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value, username: f.username || suggest(e.target.value) })} placeholder="example.com" autoFocus />
      </Field>
      <div className="form-row">
        <Field label="Username" hint="3–16 lowercase letters or digits.">
          <input value={f.username} onChange={set('username')} />
        </Field>
        <Field label="Contact email">
          <input type="email" value={f.email} onChange={set('email')} />
        </Field>
      </div>
      <Field label="Password" hint="Used to sign in here and for SFTP.">
        <PasswordInput value={f.password} onChange={(password) => setF({ ...f, password })} />
      </Field>
      <Field label="Package">
        <select value={f.packageId} onChange={set('packageId')}>
          {pkgs.map((p) => <option key={p.id} value={p.id}>{p.name} — {formatBytes(p.disk_mb * 1048576)} disk</option>)}
        </select>
      </Field>
    </FormModal>
  );
}

function ManageAccount({ account, pkgs, onClose, onDone, onTerminate }: { account: Account; pkgs: Pkg[]; onClose: () => void; onDone: () => void; onTerminate: () => void }) {
  const [email, setEmail] = useState(account.email);
  const [packageId, setPackageId] = useState(account.packageId);
  const [password, setPassword] = useState('');
  const { run, busy } = useAction();
  const suspended = account.status === 'suspended';

  return (
    <FormModal
      title={`Manage ${account.username}`}
      submitLabel="Save changes"
      onClose={onClose}
      onSubmit={async () => { await put(`/api/admin/accounts/${account.id}`, { email, packageId, ...(password ? { password } : {}) }); onDone(); }}
    >
      <Field label="Contact email"><input value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <Field label="Package">
        <select value={packageId} onChange={(e) => setPackageId(Number(e.target.value))}>
          {pkgs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Field>
      <Field label="New password" hint="Leave empty to keep the current one.">
        <PasswordInput value={password} onChange={setPassword} />
      </Field>
      <div className="module" style={{ padding: 14 }}>
        <div className="row">
          <div className="spacer">
            <strong>{suspended ? 'Account is suspended' : 'Suspend account'}</strong>
            <p className="muted" style={{ fontSize: '0.86rem' }}>
              {suspended ? 'Sites show a suspended page; mail is received but cannot be read.' : 'Takes sites offline, blocks sign-in, SFTP, mail login, cron and database access. Nothing is deleted.'}
            </p>
          </div>
          <button
            type="button"
            className={suspended ? '' : 'danger'}
            disabled={busy}
            onClick={() => run(async () => { await post(`/api/admin/accounts/${account.id}/${suspended ? 'unsuspend' : 'suspend'}`); onDone(); onClose(); }, suspended ? 'Account unsuspended' : 'Account suspended')}
          >
            {suspended ? 'Unsuspend' : 'Suspend'}
          </button>
        </div>
      </div>
      <div className="row">
        <span className="spacer muted" style={{ fontSize: '0.86rem' }}>Terminating deletes every file, database and mailbox.</span>
        <button type="button" className="danger" onClick={onTerminate}>Terminate…</button>
      </div>
    </FormModal>
  );
}

function Terminate({ account, onClose, onDone }: { account: Account; onClose: () => void; onDone: () => void }) {
  const [confirm, setConfirm] = useState('');
  const [problems, setProblems] = useState<string[] | null>(null);
  if (problems) {
    return (
      <FormModal title="Terminated with warnings" submitLabel="Close" onClose={onClose} onSubmit={async () => undefined}>
        <p>The account was removed, but some cleanup steps reported problems:</p>
        <ErrorBox error={new Error(problems.join('\n'))} />
      </FormModal>
    );
  }
  return (
    <FormModal
      title={`Terminate ${account.username}`}
      submitLabel="Terminate permanently"
      danger
      onClose={onClose}
      onSubmit={async () => {
        const r = await del<{ problems: string[] }>(`/api/admin/accounts/${account.id}`, { confirm });
        onDone();
        if (r.problems.length) {
          setProblems(r.problems);
          throw new Error('Completed with warnings — see above.');
        }
      }}
    >
      <p>This deletes the home folder, all websites, databases, mailboxes, DNS zones and certificates for <strong>{account.domain}</strong>. It can't be undone.</p>
      <Field label={`Type ${account.username} to confirm`}>
        <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
      </Field>
    </FormModal>
  );
}
