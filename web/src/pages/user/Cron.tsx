import { useState } from 'react';
import { del, get, post } from '../../api';
import { Empty, ErrorBox, Field, Loading, Module, PageHead, useAction, useLoad } from '../../components/ui';

interface Job { id: number; schedule: string; command: string; created_at: string }

const PRESETS: Array<[string, string]> = [
  ['*/5 * * * *', 'Every 5 minutes'],
  ['*/15 * * * *', 'Every 15 minutes'],
  ['@hourly', 'Every hour'],
  ['0 3 * * *', 'Daily at 03:00'],
  ['0 3 * * 0', 'Weekly, Sunday 03:00'],
  ['0 3 1 * *', 'Monthly, 1st at 03:00'],
];

export default function Cron() {
  const { data, error, loading, reload } = useLoad(() => get<Job[]>('/api/cron'));
  const [schedule, setSchedule] = useState('*/15 * * * *');
  const [command, setCommand] = useState('');
  const { run, busy } = useAction();

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await post('/api/cron', { schedule, command });
      setCommand('');
      await reload();
    }, 'Cron job added');
  };

  return (
    <>
      <PageHead title="Cron jobs" sub="Commands run as your account on the server's clock, with your home folder as the working directory." />
      <Module title="Add a job">
        <form className="form" onSubmit={add}>
          <div className="form-row cron-row">
            <Field label="Common schedules">
              <select value={PRESETS.some(([s]) => s === schedule) ? schedule : ''} onChange={(e) => e.target.value && setSchedule(e.target.value)}>
                <option value="">Custom</option>
                {PRESETS.map(([s, l]) => <option key={s} value={s}>{l}</option>)}
              </select>
            </Field>
            <Field label="Schedule" hint="minute hour day month weekday">
              <input value={schedule} onChange={(e) => setSchedule(e.target.value)} className="mono" />
            </Field>
            <Field label="Command">
              <input value={command} onChange={(e) => setCommand(e.target.value)} className="mono" placeholder="php ~/public_html/wp-cron.php > /dev/null 2>&1" />
            </Field>
          </div>
          <div><button className="primary" disabled={busy || !command}>Add job</button></div>
        </form>
      </Module>
      <Module flush title="Scheduled">
        {loading && !data ? <Loading /> : error ? <div className="module-body"><ErrorBox error={error} /></div> : !data?.length ? <Empty title="No cron jobs" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Schedule</th><th>Command</th><th /></tr></thead>
              <tbody>
                {data.map((j) => (
                  <tr key={j.id}>
                    <td style={{ whiteSpace: 'nowrap' }}><code>{j.schedule}</code></td>
                    <td style={{ overflowWrap: 'anywhere' }}><code>{j.command}</code></td>
                    <td className="actions">
                      <button className="small danger" disabled={busy} onClick={() => run(async () => { await del(`/api/cron/${j.id}`); await reload(); }, 'Cron job deleted')}>Delete</button>
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
