import { useState } from 'react';
import { Plus } from 'lucide-react';
import { del, get, post } from '../../api';
import { Empty, ErrorBox, Field, FormModal, Loading, Module, PageHead, PasswordInput, useAction, useLoad } from '../../components/ui';

interface Data {
  domains: Array<{ id: number; name: string }>;
  accounts: Array<{ id: number; local_part: string; quota_mb: number; domain: string; domain_id: number }>;
  forwarders: Array<{ id: number; local_part: string; destination: string; domain: string }>;
}

export default function Email() {
  const { data, error, loading, reload } = useLoad(() => get<Data>('/api/email'));
  const [modal, setModal] = useState<null | 'box' | 'fwd' | { password: { id: number; address: string } }>(null);
  const { run, busy } = useAction();

  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;

  return (
    <>
      <PageHead title="Email" sub="Mailboxes are read over IMAP and sent through SMTP on mail.yourdomain. Forwarders pass incoming mail on to another address.">
        <button onClick={() => setModal('fwd')}><Plus /> Forwarder</button>
        <button className="primary" onClick={() => setModal('box')}><Plus /> Mailbox</button>
      </PageHead>

      <Module flush title="Mailboxes">
        {data.accounts.length === 0 ? <Empty title="No mailboxes yet">Create one like hello@{data.domains[0]?.name ?? 'yourdomain'}.</Empty> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Address</th><th>Quota</th><th /></tr></thead>
              <tbody>
                {data.accounts.map((a) => {
                  const address = `${a.local_part}@${a.domain}`;
                  return (
                    <tr key={a.id}>
                      <td>{address}</td>
                      <td className="muted">{a.quota_mb >= 1024 ? `${(a.quota_mb / 1024).toFixed(a.quota_mb % 1024 ? 1 : 0)} GB` : `${a.quota_mb} MB`}</td>
                      <td className="actions">
                        <button className="small" onClick={() => setModal({ password: { id: a.id, address } })}>Change password</button>
                        <button
                          className="small danger"
                          disabled={busy}
                          onClick={() => confirm(`Delete ${address} and all of its mail?`) && run(async () => { await del(`/api/email/accounts/${a.id}`); await reload(); }, `Deleted ${address}`)}
                        >Delete</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Module>

      <Module flush title="Forwarders">
        {data.forwarders.length === 0 ? <Empty title="No forwarders" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>From</th><th>To</th><th /></tr></thead>
              <tbody>
                {data.forwarders.map((f) => (
                  <tr key={f.id}>
                    <td>{f.local_part}@{f.domain}</td>
                    <td>{f.destination}</td>
                    <td className="actions">
                      <button className="small danger" disabled={busy} onClick={() => run(async () => { await del(`/api/email/forwarders/${f.id}`); await reload(); }, 'Forwarder deleted')}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Module>

      <Module title="Mail client settings">
        <dl className="kv">
          <dt>Username</dt><dd>The full email address</dd>
          <dt>Incoming (IMAP)</dt><dd><code>mail.yourdomain</code>, port <code>993</code>, SSL/TLS</dd>
          <dt>Outgoing (SMTP)</dt><dd><code>mail.yourdomain</code>, port <code>587</code>, STARTTLS, password authentication</dd>
        </dl>
      </Module>

      {modal === 'box' && <MailboxModal domains={data.domains} onClose={() => setModal(null)} onDone={reload} />}
      {modal === 'fwd' && <ForwarderModal domains={data.domains} onClose={() => setModal(null)} onDone={reload} />}
      {modal && typeof modal === 'object' && (
        <PasswordModal box={modal.password} onClose={() => setModal(null)} />
      )}
    </>
  );
}

function AddressInput({ domains, local, setLocal, domainId, setDomainId }: { domains: Data['domains']; local: string; setLocal: (v: string) => void; domainId: number; setDomainId: (v: number) => void }) {
  return (
    <div className="row" style={{ flexWrap: 'nowrap' }}>
      <input value={local} onChange={(e) => setLocal(e.target.value)} placeholder="hello" autoFocus aria-label="Mailbox name" />
      <span className="muted">@</span>
      <select value={domainId} onChange={(e) => setDomainId(Number(e.target.value))} aria-label="Domain">
        {domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
    </div>
  );
}

function MailboxModal({ domains, onClose, onDone }: { domains: Data['domains']; onClose: () => void; onDone: () => void }) {
  const [local, setLocal] = useState('');
  const [domainId, setDomainId] = useState(domains[0]?.id ?? 0);
  const [password, setPassword] = useState('');
  const [quotaMb, setQuotaMb] = useState('1024');
  return (
    <FormModal title="Create mailbox" submitLabel="Create mailbox" onClose={onClose} onSubmit={async () => { await post('/api/email/accounts', { local, domainId, password, quotaMb }); onDone(); }}>
      <Field label="Address"><AddressInput domains={domains} local={local} setLocal={setLocal} domainId={domainId} setDomainId={setDomainId} /></Field>
      <Field label="Password" hint="At least 10 characters."><PasswordInput value={password} onChange={setPassword} /></Field>
      <Field label="Quota (MB)"><input type="number" min={10} value={quotaMb} onChange={(e) => setQuotaMb(e.target.value)} /></Field>
    </FormModal>
  );
}

function ForwarderModal({ domains, onClose, onDone }: { domains: Data['domains']; onClose: () => void; onDone: () => void }) {
  const [local, setLocal] = useState('');
  const [domainId, setDomainId] = useState(domains[0]?.id ?? 0);
  const [destination, setDestination] = useState('');
  return (
    <FormModal title="Create forwarder" submitLabel="Create forwarder" onClose={onClose} onSubmit={async () => { await post('/api/email/forwarders', { local, domainId, destination }); onDone(); }}>
      <Field label="Forward mail sent to"><AddressInput domains={domains} local={local} setLocal={setLocal} domainId={domainId} setDomainId={setDomainId} /></Field>
      <Field label="To" hint="If this address also has a mailbox, it keeps a copy."><input type="email" value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="you@gmail.com" /></Field>
    </FormModal>
  );
}

function PasswordModal({ box, onClose }: { box: { id: number; address: string }; onClose: () => void }) {
  const [password, setPassword] = useState('');
  return (
    <FormModal title={`Password for ${box.address}`} submitLabel="Change password" onClose={onClose} onSubmit={() => post(`/api/email/accounts/${box.id}/password`, { password })}>
      <Field label="New password"><PasswordInput value={password} onChange={setPassword} /></Field>
    </FormModal>
  );
}
