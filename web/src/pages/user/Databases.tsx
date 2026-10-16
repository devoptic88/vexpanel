import { useState } from 'react';
import { Plus } from 'lucide-react';
import { del, formatBytes, get, post } from '../../api';
import { Empty, ErrorBox, Field, FormModal, Loading, Module, PageHead, PasswordInput, useAction, useLoad } from '../../components/ui';

interface Data {
  prefix: string;
  databases: Array<{ id: number; name: string; sizeBytes: number | null; users: number[] }>;
  users: Array<{ id: number; name: string }>;
}

export default function Databases() {
  const { data, error, loading, reload } = useLoad(() => get<Data>('/api/databases'));
  const [modal, setModal] = useState<null | 'db' | 'user' | { password: { id: number; name: string } } | { access: number }>(null);
  const { run, busy } = useAction();

  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const userName = (id: number) => data.users.find((u) => u.id === id)?.name ?? '?';

  return (
    <>
      <PageHead title="Databases" sub={<>MariaDB on <code>localhost</code>. Names start with <code>{data.prefix}</code>. Create a database, create a user, then give the user access.</>}>
        <button onClick={() => setModal('user')}><Plus /> Database user</button>
        <button className="primary" onClick={() => setModal('db')}><Plus /> Database</button>
      </PageHead>

      <Module flush title="Databases">
        {data.databases.length === 0 ? <Empty title="No databases yet">Most apps, like WordPress, need one database and one user.</Empty> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Size</th><th>Users with access</th><th /></tr></thead>
              <tbody>
                {data.databases.map((d) => (
                  <tr key={d.id}>
                    <td><code>{d.name}</code></td>
                    <td className="muted">{formatBytes(d.sizeBytes)}</td>
                    <td>
                      <div className="row">
                        {d.users.length === 0 && <span className="muted">Nobody</span>}
                        {d.users.map((uid) => (
                          <span className="tag" key={uid}>
                            <code>{userName(uid)}</code>{' '}
                            <button
                              className="ghost small"
                              style={{ padding: '0 2px' }}
                              aria-label={`Remove ${userName(uid)}'s access`}
                              onClick={() => run(async () => { await post('/api/databases/grants', { databaseId: d.id, userId: uid, grant: false }); await reload(); }, 'Access removed')}
                            >×</button>
                          </span>
                        ))}
                        {data.users.length > 0 && <button className="small" onClick={() => setModal({ access: d.id })}>Add user</button>}
                      </div>
                    </td>
                    <td className="actions">
                      <button
                        className="small danger"
                        disabled={busy}
                        onClick={() => confirm(`Delete ${d.name} and all of its tables? This can't be undone.`) && run(async () => { await del(`/api/databases/${d.id}`); await reload(); }, `Deleted ${d.name}`)}
                      >Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Module>

      <Module flush title="Database users">
        {data.users.length === 0 ? <Empty title="No database users yet" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>User</th><th>Host</th><th /></tr></thead>
              <tbody>
                {data.users.map((u) => (
                  <tr key={u.id}>
                    <td><code>{u.name}</code></td>
                    <td><code>localhost</code></td>
                    <td className="actions">
                      <button className="small" onClick={() => setModal({ password: u })}>Change password</button>
                      <button
                        className="small danger"
                        disabled={busy}
                        onClick={() => confirm(`Delete user ${u.name}?`) && run(async () => { await del(`/api/databases/users/${u.id}`); await reload(); }, `Deleted ${u.name}`)}
                      >Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Module>

      {modal === 'db' && <NameModal kind="db" prefix={data.prefix} onClose={() => setModal(null)} onDone={reload} />}
      {modal === 'user' && <NameModal kind="user" prefix={data.prefix} onClose={() => setModal(null)} onDone={reload} />}
      {modal && typeof modal === 'object' && 'password' in modal && <PasswordModal user={modal.password} onClose={() => setModal(null)} />}
      {modal && typeof modal === 'object' && 'access' in modal && (
        <AccessModal db={data.databases.find((d) => d.id === modal.access)!} users={data.users} onClose={() => setModal(null)} onDone={reload} />
      )}
    </>
  );
}

function NameModal({ kind, prefix, onClose, onDone }: { kind: 'db' | 'user'; prefix: string; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  return (
    <FormModal
      title={kind === 'db' ? 'Create database' : 'Create database user'}
      submitLabel={kind === 'db' ? 'Create database' : 'Create user'}
      onClose={onClose}
      onSubmit={async () => {
        if (kind === 'db') await post('/api/databases', { name });
        else await post('/api/databases/users', { name, password });
        onDone();
      }}
    >
      <Field label="Name" hint="Lowercase letters, digits and underscore.">
        <div className="prefixed"><span>{prefix}</span><input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></div>
      </Field>
      {kind === 'user' && (
        <Field label="Password" hint="At least 12 characters. Save it — you'll need it in your app's config.">
          <PasswordInput value={password} onChange={setPassword} />
        </Field>
      )}
    </FormModal>
  );
}

function PasswordModal({ user, onClose }: { user: { id: number; name: string }; onClose: () => void }) {
  const [password, setPassword] = useState('');
  return (
    <FormModal title={`Password for ${user.name}`} submitLabel="Change password" onClose={onClose} onSubmit={() => post(`/api/databases/users/${user.id}/password`, { password })}>
      <Field label="New password" hint="Update any app that uses this user afterwards.">
        <PasswordInput value={password} onChange={setPassword} />
      </Field>
    </FormModal>
  );
}

function AccessModal({ db, users, onClose, onDone }: { db: { id: number; name: string; users: number[] }; users: Array<{ id: number; name: string }>; onClose: () => void; onDone: () => void }) {
  const choices = users.filter((u) => !db.users.includes(u.id));
  const [userId, setUserId] = useState(choices[0]?.id ?? 0);
  return (
    <FormModal title={`Give access to ${db.name}`} submitLabel="Grant all privileges" onClose={onClose} onSubmit={async () => { await post('/api/databases/grants', { databaseId: db.id, userId }); onDone(); }}>
      {choices.length === 0 ? <p className="muted">Every user already has access.</p> : (
        <Field label="User">
          <select value={userId} onChange={(e) => setUserId(Number(e.target.value))}>
            {choices.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </Field>
      )}
    </FormModal>
  );
}
