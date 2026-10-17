import { useEffect, useState, type ReactNode } from 'react';
import { BookOpen, ExternalLink, MessagesSquare, Newspaper, Upload, Wrench } from 'lucide-react';
import { get, post } from '../../api';
import { Empty, ErrorBox, Field, FormModal, Loading, Modal, Module, PageHead, PasswordInput, useAction, useLoad } from '../../components/ui';

interface CatalogApp {
  id: string;
  name: string;
  category: string;
  description: string;
  database: boolean;
  setup: 'auto' | 'wizard';
  defaultFolder: string;
  needsAdmin?: boolean;
  homepage: string;
  upload: boolean;
}

interface Install {
  id: number;
  appId: string;
  version: string;
  path: string;
  url: string;
  status: 'installing' | 'ready' | 'failed' | 'removing';
  message: string;
  setupUrl: string;
  adminUrl: string;
  database: { name: string; user: string; password: string; host: string } | null;
}

interface Data {
  catalog: CatalogApp[];
  locations: Array<{ id: string; label: string; baseUrl: string }>;
  installs: Install[];
  email: string;
}

const CATEGORY_ICON: Record<string, ReactNode> = {
  Forums: <MessagesSquare />,
  'Blogs & CMS': <Newspaper />,
  Wikis: <BookOpen />,
  Tools: <Wrench />,
  'Your own software': <Upload />,
};

export default function Apps() {
  const { data, error, loading, reload } = useLoad(() => get<Data>('/api/apps'));
  const [installing, setInstalling] = useState<CatalogApp | null>(null);
  const [showDb, setShowDb] = useState<Install | null>(null);
  const [removing, setRemoving] = useState<Install | null>(null);

  // Poll while anything is installing or being removed.
  const busy = data?.installs.some((i) => i.status === 'installing' || i.status === 'removing');
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void reload(), 2000);
    return () => clearInterval(t);
  }, [busy, reload]);

  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const appName = (id: string) => data.catalog.find((a) => a.id === id)?.name ?? id;
  const ORDER = ['Forums', 'Blogs & CMS', 'Wikis', 'Tools', 'Your own software'];
  const categories = [...new Set(data.catalog.map((a) => a.category))].sort((x, y) => ORDER.indexOf(x) - ORDER.indexOf(y));

  return (
    <>
      <PageHead
        title="Apps"
        sub="Install forums, blogs and other web apps in one step. The panel downloads the latest release, creates its database and, for some apps, finishes setup for you."
      />

      {data.installs.length > 0 && (
        <Module flush title="Installed">
          <div className="table-wrap">
            <table>
              <thead><tr><th>App</th><th>Address</th><th>Status</th><th /></tr></thead>
              <tbody>
                {data.installs.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <strong>{appName(i.appId)}</strong>
                      {i.version && i.version !== 'latest' && <span className="muted"> {i.version}</span>}
                      <br /><code className="muted">~/{i.path}</code>
                    </td>
                    <td style={{ overflowWrap: 'anywhere' }}>
                      {i.status === 'ready' ? <a href={i.url} target="_blank" rel="noreferrer">{i.url}</a> : <span className="muted">{i.url}</span>}
                    </td>
                    <td style={{ maxWidth: 320 }}>
                      <InstallStatus i={i} />
                    </td>
                    <td className="actions">
                      {i.status === 'ready' && i.setupUrl && (
                        <a className="btn small primary" href={i.setupUrl} target="_blank" rel="noreferrer">Finish setup <ExternalLink /></a>
                      )}
                      {i.status === 'ready' && i.adminUrl && !i.setupUrl && (
                        <a className="btn small" href={i.adminUrl} target="_blank" rel="noreferrer">Admin <ExternalLink /></a>
                      )}
                      {i.database && <button className="small" onClick={() => setShowDb(i)}>Database</button>}
                      {(i.status === 'ready' || i.status === 'failed') && (
                        <button className="small danger" onClick={() => setRemoving(i)}>Remove</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Module>
      )}

      {categories.map((cat) => (
        <Module key={cat} title={cat}>
          <div className="apps-grid">
            {data.catalog.filter((a) => a.category === cat).map((a) => (
              <div className="app-card" key={a.id}>
                <div className="app-card-head">
                  {CATEGORY_ICON[a.category]}
                  <h3>{a.name}</h3>
                </div>
                <p>{a.description}</p>
                <div className="row">
                  <span className="tag">{a.upload ? 'Your package' : a.setup === 'auto' ? 'Fully automatic' : 'Setup page'}</span>
                  {a.database && <span className="tag">Database</span>}
                  <span className="spacer" />
                  <button className="small primary" onClick={() => setInstalling(a)}>Install</button>
                </div>
              </div>
            ))}
          </div>
        </Module>
      ))}

      {installing && <InstallModal app={installing} locations={data.locations} email={data.email} onClose={() => setInstalling(null)} onDone={reload} />}
      {showDb?.database && (
        <Modal title={`${appName(showDb.appId)} database`} onClose={() => setShowDb(null)} footer={<button onClick={() => setShowDb(null)}>Close</button>}>
          <p className="muted" style={{ marginBottom: 14 }}>
            {showDb.setupUrl ? 'Enter these on the setup page.' : 'The app is already configured with these. Keep them for backups or phpMyAdmin.'}
          </p>
          <dl className="kv">
            <dt>Database host</dt><dd><code>{showDb.database.host}</code></dd>
            <dt>Database name</dt><dd><code>{showDb.database.name}</code></dd>
            <dt>Database user</dt><dd><code>{showDb.database.user}</code></dd>
            <dt>Password</dt><dd><code>{showDb.database.password}</code></dd>
          </dl>
        </Modal>
      )}
      {removing && <RemoveModal i={removing} name={appName(removing.appId)} onClose={() => setRemoving(null)} onDone={reload} />}
    </>
  );
}

function InstallStatus({ i }: { i: Install }) {
  if (i.status === 'installing') return <span className="status warn">{i.message || 'Installing…'}</span>;
  if (i.status === 'removing') return <span className="status warn">Removing…</span>;
  if (i.status === 'failed') return (<><span className="status bad">Failed</span><br /><small className="muted">{i.message}</small></>);
  return (
    <>
      <span className="status ok">{i.setupUrl ? 'Files ready' : 'Installed'}</span>
      {i.message && <><br /><small className="muted">{i.message}</small></>}
    </>
  );
}

function InstallModal({ app, locations, email, onClose, onDone }: { app: CatalogApp; locations: Data['locations']; email: string; onClose: () => void; onDone: () => void }) {
  const [location, setLocation] = useState(locations[0]?.id ?? '');
  const [folder, setFolder] = useState(app.defaultFolder);
  const [title, setTitle] = useState('');
  const [adminUser, setAdminUser] = useState('admin');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminEmail, setAdminEmail] = useState(email);
  const [archive, setArchive] = useState('');
  const [createDatabase, setCreateDatabase] = useState(true);
  const base = locations.find((l) => l.id === location)?.baseUrl ?? '';
  const cleanFolder = folder.trim().replace(/^\/+|\/+$/g, '');

  return (
    <FormModal
      title={`Install ${app.name}`}
      submitLabel="Install"
      onClose={onClose}
      onSubmit={async () => {
        await post('/api/apps/install', { appId: app.id, location, folder: cleanFolder, title, adminUser, adminPassword, adminEmail, archive, createDatabase });
        onDone();
      }}
    >
      {app.upload && (
        <>
          <Field label="Package file" hint="Path in your home folder, e.g. vbulletin.zip. Upload it in the file manager first.">
            <div className="prefixed"><span>~/</span><input value={archive} onChange={(e) => setArchive(e.target.value)} placeholder="vbulletin_5.7.5.zip" autoFocus /></div>
          </Field>
          <label className="check">
            <input type="checkbox" checked={createDatabase} onChange={(e) => setCreateDatabase(e.target.checked)} />
            Create a database for it
          </label>
        </>
      )}
      <div className="form-row">
        <Field label="Install on">
          <select value={location} onChange={(e) => setLocation(e.target.value)}>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </Field>
        <Field label="Folder" hint="Leave empty to install at the top level.">
          <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="(top level)" />
        </Field>
      </div>
      <p className="muted" style={{ fontSize: '0.88rem' }}>
        It will be at <code>{base}{cleanFolder ? `${cleanFolder}/` : ''}</code>
      </p>
      {app.needsAdmin && (
        <>
          <Field label={app.id === 'phpbb' ? 'Board name' : 'Site title'}>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={app.name} />
          </Field>
          <div className="form-row">
            <Field label="Admin username"><input value={adminUser} onChange={(e) => setAdminUser(e.target.value)} autoComplete="off" /></Field>
            <Field label="Admin email"><input type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} /></Field>
          </div>
          <Field label="Admin password" hint="At least 10 characters. You'll sign in to the app with this.">
            <PasswordInput value={adminPassword} onChange={setAdminPassword} />
          </Field>
        </>
      )}
      {!app.needsAdmin && !app.upload && app.setup === 'wizard' && (
        <p className="muted" style={{ fontSize: '0.88rem' }}>
          The panel downloads {app.name}{app.database ? ' and creates its database' : ''}. You'll then finish on {app.name}'s own setup page, where you choose the admin account{app.database ? ' and enter the database details the panel shows you' : ''}.
        </p>
      )}
    </FormModal>
  );
}

function RemoveModal({ i, name, onClose, onDone }: { i: Install; name: string; onClose: () => void; onDone: () => void }) {
  const [dropDatabase, setDropDatabase] = useState(true);
  const { busy } = useAction();
  return (
    <FormModal
      title={`Remove ${name}`}
      submitLabel={busy ? 'Removing…' : 'Remove'}
      danger
      onClose={onClose}
      onSubmit={async () => { await post(`/api/apps/${i.id}/remove`, { dropDatabase }); onDone(); }}
    >
      <p>
        {i.status === 'failed'
          ? 'This removes the failed install from the list.'
          : <>This deletes the files in <code>~/{i.path}</code>. Apps installed in its subfolders are kept.</>}
      </p>
      {i.database && i.status !== 'failed' && (
        <label className="check">
          <input type="checkbox" checked={dropDatabase} onChange={(e) => setDropDatabase(e.target.checked)} />
          Also delete its database <code>{i.database.name}</code> and all its data
        </label>
      )}
      {!i.database && i.status !== 'failed' && <Empty title="No database to remove" />}
    </FormModal>
  );
}
