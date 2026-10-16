/**
 * vexpanel CLI — run as root on the server.
 *   vexpanel reset-admin-password [username]   prints a new random password
 *   vexpanel rebuild                            re-render every vhost, zone, mail map and crontab from the database
 */
import { randomBytes } from 'node:crypto';
import { all, exec, one } from './db.js';
import { hashPassword } from './auth.js';
import { applyAccountWeb } from './services/web.js';
import { applyZone } from './services/dns.js';
import { applyMail } from './services/mail.js';
import { applyCron } from './services/cron.js';

const [cmd, arg] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case 'reset-admin-password': {
      const name = arg ?? 'admin';
      const u = one<{ id: number }>("SELECT id FROM users WHERE username = ? AND role = 'admin'", name);
      if (!u) throw new Error(`No admin named ${name}`);
      const pw = randomBytes(12).toString('base64url');
      exec('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(pw), u.id);
      exec('DELETE FROM sessions WHERE user_id = ?', u.id);
      console.log(`New password for ${name}: ${pw}`);
      break;
    }
    case 'rebuild': {
      for (const u of all<{ id: number; username: string }>("SELECT id, username FROM users WHERE role = 'user'")) {
        console.log(`account ${u.username}`);
        await applyAccountWeb(u.id);
        await applyCron(u.id);
      }
      for (const d of all<{ id: number; name: string }>("SELECT id, name FROM domains WHERE type IN ('main','addon')")) {
        console.log(`zone ${d.name}`);
        await applyZone(d.id);
      }
      await applyMail();
      console.log('done');
      break;
    }
    default:
      console.log('Usage: vexpanel reset-admin-password [username] | vexpanel rebuild');
      process.exit(cmd ? 1 : 0);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error((e as Error).message, (e as { detail?: string }).detail ?? '');
    process.exit(1);
  },
);
