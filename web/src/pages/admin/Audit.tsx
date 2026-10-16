import { get } from '../../api';
import { Empty, ErrorBox, Loading, Module, PageHead, useLoad } from '../../components/ui';

interface Entry { id: number; actor: string; action: string; detail: string; ip: string; created_at: string }

export default function Audit() {
  const { data, error, loading } = useLoad(() => get<Entry[]>('/api/admin/audit?limit=300'));
  return (
    <>
      <PageHead title="Activity log" sub="Every change made through the panel, newest first, including failed sign-ins." />
      <Module flush>
        {loading && !data ? <Loading /> : error ? <div className="module-body"><ErrorBox error={error} /></div> : !data?.length ? (
          <Empty title="Nothing logged yet" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>When (UTC)</th><th>Who</th><th>Action</th><th>Detail</th><th>IP</th></tr></thead>
              <tbody>
                {data.map((e) => (
                  <tr key={e.id}>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>{e.created_at}</td>
                    <td>{e.actor}</td>
                    <td><code>{e.action}</code></td>
                    <td style={{ overflowWrap: 'anywhere' }}>{e.detail}</td>
                    <td className="muted"><code>{e.ip}</code></td>
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
