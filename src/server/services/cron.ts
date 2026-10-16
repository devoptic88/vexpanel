import { all, one, type UserRow } from '../db.js';
import { run, serial } from '../sys/exec.js';

/** Render a user's crontab. Pure, unit-tested. */
export function renderCrontab(jobs: Array<{ id: number; schedule: string; command: string }>, suspended: boolean): string {
  const header = '# Managed by VEXPANEL — edit cron jobs in the panel.\nSHELL=/bin/bash\nMAILTO=""\n';
  if (suspended) return header + '# Account suspended: jobs disabled.\n';
  return header + jobs.map((j) => `# vex-job-${j.id}\n${j.schedule} ${j.command}`).join('\n') + '\n';
}

export function applyCron(userId: number) {
  return serial(async () => {
    const u = one<UserRow>('SELECT * FROM users WHERE id = ?', userId);
    if (!u) return;
    const jobs = all<{ id: number; schedule: string; command: string }>('SELECT id, schedule, command FROM cron_jobs WHERE user_id = ? ORDER BY id', userId);
    await run('crontab', ['-u', u.username, '-'], { input: renderCrontab(jobs, u.status === 'suspended') });
  });
}
