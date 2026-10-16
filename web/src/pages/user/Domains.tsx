import { useState } from 'react';
import { Plus } from 'lucide-react';
import { del, get, post } from '../../api';
import { Empty, ErrorBox, Field, FormModal, Loading, Module, PageHead, useAction, useLoad } from '../../components/ui';

export interface Domain { id: number; name: string; type: 'main' | 'addon' | 'sub'; parent_id: number | null; docroot: string; ssl: number; ssl_expires: string | null }

const TYPE_LABEL = { main: 'Main', addon: 'Addon', sub: 'Subdomain' };

export default function Domains() {
  const list = useLoad(() => get<Domain[]>('/api/domains'));
  const [adding, setAdding] = useState<'addon' | 'sub' | null>(null);
  const { run, busy } = useAction();
  const roots = (list.data ?? []).filter((d) => d.type !== 'sub');

  return (
    <>
      <PageHead title="Domains" sub="Each domain gets its own website folder. Addon domains also get a DNS zone and email.">
        <button onClick={() => setAdding('sub')}><Plus /> Subdomain</button>
        <button className="primary" onClick={() => setAdding('addon')}><Plus /> Addon domain</button>
      </PageHead>
      <Module flush>
        {list.loading && !list.data ? <Loading /> : list.error ? <div className="module-body"><ErrorBox error={list.error} /></div> : !list.data?.length ? (
          <Empty title="No domains" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Domain</th><th>Type</th><th>Website folder</th><th>HTTPS</th><th /></tr></thead>
              <tbody>
                {list.data.map((d) => (
                  <tr key={d.id}>
                    <td><a href={`${d.ssl ? 'https' : 'http'}://${d.name}`} target="_blank" rel="noreferrer">{d.name}</a></td>
                    <td><span className={`tag${d.type === 'main' ? ' blue' : ''}`}>{TYPE_LABEL[d.type]}</span></td>
                    <td><code>~/{d.docroot}</code></td>
                    <td><span className={`status ${d.ssl ? 'ok' : ''}`}>{d.ssl ? 'On' : 'Off'}</span></td>
                    <td className="actions">
                      {d.type !== 'main' && (
                        <button
                          className="small danger"
                          disabled={busy}
                          onClick={() =>
                            confirm(`Remove ${d.name}? Its files stay in ~/${d.docroot}${d.type === 'addon' ? ', but its DNS zone and mailboxes are deleted' : ''}.`) &&
                            run(async () => { await del(`/api/domains/${d.id}`); await list.reload(); }, `Removed ${d.name}`)
                          }
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Module>
      {adding && <AddDomain type={adding} roots={roots} onClose={() => setAdding(null)} onDone={list.reload} />}
    </>
  );
}

function AddDomain({ type, roots, onClose, onDone }: { type: 'addon' | 'sub'; roots: Domain[]; onClose: () => void; onDone: () => void }) {
  const [domain, setDomain] = useState('');
  const [label, setLabel] = useState('');
  const [parentId, setParentId] = useState(roots[0]?.id ?? 0);
  const [docroot, setDocroot] = useState('');
  const parent = roots.find((r) => r.id === Number(parentId));
  const defaultRoot = type === 'addon' ? domain.toLowerCase() || 'example.com' : `public_html/${label.toLowerCase() || 'blog'}`;

  return (
    <FormModal
      title={type === 'addon' ? 'Add addon domain' : 'Add subdomain'}
      submitLabel={type === 'addon' ? 'Add domain' : 'Add subdomain'}
      onClose={onClose}
      onSubmit={async () => {
        await post('/api/domains', type === 'addon' ? { type, domain, docroot } : { type, label, parentId: Number(parentId), docroot });
        onDone();
      }}
    >
      {type === 'addon' ? (
        <Field label="Domain" hint="Point the domain's nameservers at this server so its DNS and email work.">
          <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="anothersite.com" autoFocus />
        </Field>
      ) : (
        <div className="form-row">
          <Field label="Subdomain">
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="blog" autoFocus />
          </Field>
          <Field label="Of domain">
            <select value={parentId} onChange={(e) => setParentId(Number(e.target.value))}>
              {roots.map((r) => <option key={r.id} value={r.id}>.{r.name}</option>)}
            </select>
          </Field>
        </div>
      )}
      {type === 'sub' && label && parent && <p className="muted">Creates <strong>{label.toLowerCase()}.{parent.name}</strong> and an A record pointing at this server.</p>}
      <Field label="Website folder" hint="Inside your home folder. Leave empty for the default.">
        <div className="prefixed"><span>~/</span><input value={docroot} onChange={(e) => setDocroot(e.target.value)} placeholder={defaultRoot} /></div>
      </Field>
    </FormModal>
  );
}
