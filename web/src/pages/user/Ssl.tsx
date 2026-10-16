import { get, post } from '../../api';
import { Empty, ErrorBox, Loading, Module, PageHead, useAction, useLoad } from '../../components/ui';

interface Row { id: number; name: string; type: string; ssl: number; ssl_expires: string | null }

export default function Ssl() {
  const { data, error, loading, reload } = useLoad(() => get<Row[]>('/api/ssl'));
  const { run, busy } = useAction();
  const days = (iso: string) => Math.round((new Date(iso).getTime() - Date.now()) / 86400_000);

  return (
    <>
      <PageHead title="SSL certificates" sub="Free certificates from Let's Encrypt, renewed automatically before they expire. The domain must already point at this server." />
      <Module flush>
        {loading && !data ? <Loading /> : error ? <div className="module-body"><ErrorBox error={error} /></div> : !data?.length ? <Empty title="No domains" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Domain</th><th>HTTPS</th><th>Expires</th><th /></tr></thead>
              <tbody>
                {data.map((d) => (
                  <tr key={d.id}>
                    <td>{d.name}{d.type !== 'sub' && <span className="muted"> and www</span>}</td>
                    <td><span className={`status ${d.ssl ? 'ok' : ''}`}>{d.ssl ? 'Secured' : 'Not secured'}</span></td>
                    <td className="muted">{d.ssl && d.ssl_expires ? `${new Date(d.ssl_expires).toLocaleDateString()} (${days(d.ssl_expires)} days)` : '—'}</td>
                    <td className="actions">
                      <button
                        className={d.ssl ? 'small' : 'small primary'}
                        disabled={busy}
                        onClick={() => run(async () => { await post(`/api/ssl/${d.id}/issue`, { www: d.type !== 'sub' }); await reload(); }, `Certificate issued for ${d.name}`)}
                      >
                        {busy ? 'Working…' : d.ssl ? 'Renew now' : 'Issue certificate'}
                      </button>
                      {!!d.ssl && (
                        <button className="small danger" disabled={busy} onClick={() => confirm(`Turn off HTTPS for ${d.name}?`) && run(async () => { await post(`/api/ssl/${d.id}/disable`); await reload(); }, 'HTTPS turned off')}>
                          Turn off
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
    </>
  );
}
