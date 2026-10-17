import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { all, one, type DomainRow, type UserRow } from '../db.js';
import { run } from '../sys/exec.js';
import { ensureDir, removePath, writeAtomic, writeChecked } from '../sys/fsx.js';

export const NGINX_DIR = '/etc/nginx/vexpanel';
export const NGINX_LOG_DIR = '/var/log/nginx/vexpanel';
export const fpmPoolPath = (u: string) => `/etc/php/${config.phpVersion}/fpm/pool.d/vex-${u}.conf`;
export const fpmSocket = (u: string) => `/run/php/vex-${u}.sock`;
export const vhostPath = (d: string) => `${NGINX_DIR}/${d}.conf`;
export const homeOf = (u: string) => path.posix.join(config.homeBase, u);
export const suspendedRoot = () => path.join(config.dataDir, 'suspended');

const v6 = (line: string) => (config.ipv6Listen ? `\n    ${line}` : '');

export function certPaths(domain: string) {
  return {
    cert: `/etc/letsencrypt/live/${domain}/fullchain.pem`,
    key: `/etc/letsencrypt/live/${domain}/privkey.pem`,
  };
}

function serverNames(d: DomainRow): string {
  return d.type === 'sub' ? d.name : `${d.name} www.${d.name}`;
}

/** Render the nginx server blocks for one domain. Pure function, unit-tested. */
export function renderVhost(d: DomainRow, user: Pick<UserRow, 'username' | 'status'>): string {
  const names = serverNames(d);
  const suspended = user.status === 'suspended';
  const root = suspended ? suspendedRoot() : d.docroot;
  const logs = `access_log ${NGINX_LOG_DIR}/${d.name}.access.log;\n    error_log ${NGINX_LOG_DIR}/${d.name}.error.log;`;
  const acme = `location ^~ /.well-known/acme-challenge/ {\n        root ${d.docroot};\n        default_type text/plain;\n    }`;

  const body = suspended
    ? `    root ${root};
    location / {
        try_files /index.html =503;
    }`
    : `    root ${root};
    index index.php index.html index.htm;
    client_max_body_size 128m;

    location / {
        try_files $uri $uri/ /index.php?$args;
    }

    location ~ \\.php$ {
        try_files $uri =404;
        fastcgi_split_path_info ^(.+\\.php)(/.+)$;
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        fastcgi_param HTTPS $https if_not_empty;
        fastcgi_pass unix:${fpmSocket(user.username)};
    }

    location ~ /\\.(?!well-known) {
        deny all;
    }`;

  const header = `# Managed by VEXPANEL — changes here are overwritten.\n# account=${user.username} domain=${d.name} type=${d.type}\n`;

  if (!d.ssl) {
    return `${header}
server {
    listen 80;${v6('listen [::]:80;')}
    server_name ${names};
    ${logs}

    ${acme}

${body}
}
`;
  }

  const { cert, key } = certPaths(d.name);
  return `${header}
server {
    listen 80;${v6('listen [::]:80;')}
    server_name ${names};

    ${acme}

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    # 'listen ... http2' rather than 'http2 on' so nginx 1.24 (Ubuntu 24.04) accepts it.
    listen 443 ssl http2;${v6('listen [::]:443 ssl http2;')}
    server_name ${names};
    ${logs}

    ssl_certificate ${cert};
    ssl_certificate_key ${key};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:vexSSL:10m;
    add_header Strict-Transport-Security "max-age=31536000" always;

    ${acme}

${body}
}
`;
}

/** Render the PHP-FPM pool that runs this account's PHP as its own Linux user. */
export function renderFpmPool(u: string): string {
  const home = homeOf(u);
  return `; Managed by VEXPANEL — changes here are overwritten.
[vex-${u}]
user = ${u}
group = ${u}
listen = ${fpmSocket(u)}
listen.owner = www-data
listen.group = www-data
listen.mode = 0660
pm = ondemand
pm.max_children = 8
pm.process_idle_timeout = 20s
pm.max_requests = 500
chdir = /
php_admin_value[open_basedir] = ${home}/:/tmp/:/usr/share/php/
php_admin_value[upload_tmp_dir] = ${home}/tmp
php_admin_value[session.save_path] = ${home}/tmp
php_admin_value[sys_temp_dir] = ${home}/tmp
php_admin_value[error_log] = ${home}/logs/php_error.log
php_admin_flag[log_errors] = on
php_admin_value[disable_functions] = exec,passthru,shell_exec,system,proc_open,popen
`;
}

async function nginxTest() {
  await run('nginx', ['-t', '-q']);
}

export async function reloadNginx() {
  await run('systemctl', ['reload', 'nginx']);
}

export async function reloadFpm() {
  await run('systemctl', ['reload', `php${config.phpVersion}-fpm`]);
}

/** Write (or rewrite) one domain's vhost, validate with nginx -t, roll back on failure. Caller reloads. */
export async function writeVhost(d: DomainRow, user: UserRow) {
  await ensureDir(NGINX_DIR);
  await ensureDir(NGINX_LOG_DIR);
  await writeChecked(vhostPath(d.name), renderVhost(d, user), nginxTest);
}

export async function removeVhost(domainName: string) {
  await removePath(vhostPath(domainName));
}

// ---------- IP preview: http://<server-ip>/~username/ ----------
//
// Lets people reach an account's main site before any domain points at the server.
// A default nginx server answers requests by IP. Each active account gets a location that
// serves its public_html through a symlink map (/var/lib/vexpanel/ipsites/~user), with PHP
// going to that account's own FPM pool. Every site shares the IP's origin, so this is meant
// for previews and testing, not production.

export const IP_SITE_PATH = `${NGINX_DIR}/000-ip-preview.conf`;
export const ipSitesDir = () => path.join(config.dataDir, 'ipsites');
export const previewUrl = (username: string) => `http://${config.serverIp}/~${username}/`;

/** Render the default server that answers by IP. Pure function, unit-tested. */
export function renderIpSite(users: Array<Pick<UserRow, 'username' | 'status'>>): string {
  const root = ipSitesDir();
  const blocks = users.map((u) => {
    if (u.status === 'suspended') {
      return `    location ^~ /~${u.username}/ {
        root ${suspendedRoot()};
        try_files /index.html =503;
    }`;
    }
    return `    location = /~${u.username} {
        return 301 /~${u.username}/;
    }
    location ^~ /~${u.username}/ {
        root ${root};
        index index.php index.html index.htm;
        try_files $uri $uri/ /~${u.username}/index.php?$args;

        location ~ /\\. {
            deny all;
        }
        location ~ \\.php$ {
            try_files $uri =404;
            fastcgi_split_path_info ^(.+\\.php)(/.+)$;
            include fastcgi_params;
            fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
            fastcgi_pass unix:${fpmSocket(u.username)};
        }
    }`;
  });
  return `# Managed by VEXPANEL — changes here are overwritten.
# Answers requests made to the server's IP address. Account sites are at /~username/.
server {
    listen 80 default_server;${v6('listen [::]:80 default_server;')}
    server_name _;
    access_log ${NGINX_LOG_DIR}/ip-preview.access.log;
    error_log ${NGINX_LOG_DIR}/ip-preview.error.log;
    client_max_body_size 128m;

    location = / {
        default_type text/html;
        return 200 '<!doctype html><meta charset="utf-8"><title>${config.hostname}</title><body style="font:16px system-ui;display:grid;place-items:center;min-height:90vh;color:#1b2333"><p>This server is managed by VEXPANEL.</p>';
    }

    location / {
        return 404;
    }

${blocks.join('\n\n')}
}
`;
}

/** Rewrite the IP preview server and its symlink map from the database. Caller reloads nginx. */
export async function writeIpSites() {
  const users = all<UserRow>("SELECT * FROM users WHERE role = 'user' ORDER BY username");
  const dir = ipSitesDir();
  // The data dir belongs to the panel (not a system path), so it isn't redirected in dry-run mode.
  await fs.mkdir(dir, { recursive: true, mode: 0o755 });
  // Symlink map: ~user -> the account's main web root.
  const wanted = new Map<string, string>();
  for (const u of users) {
    const main = one<DomainRow>("SELECT * FROM domains WHERE user_id = ? AND type = 'main'", u.id);
    if (main) wanted.set(`~${u.username}`, main.docroot);
  }
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (!wanted.has(name)) await fs.rm(path.join(dir, name), { force: true });
  }
  for (const [name, target] of wanted) {
    const link = path.join(dir, name);
    const current = await fs.readlink(link).catch(() => null);
    if (current === target) continue;
    await fs.rm(link, { force: true });
    await fs.symlink(target, link);
  }
  // Ubuntu's stock site also claims default_server on port 80; it has to go for ours to load.
  await removePath('/etc/nginx/sites-enabled/default');
  await ensureDir(NGINX_DIR);
  await ensureDir(NGINX_LOG_DIR);
  await writeChecked(IP_SITE_PATH, renderIpSite(users.filter((u) => wanted.has(`~${u.username}`))), nginxTest);
}

/** Re-render every vhost and the FPM pool for an account (used after suspend/unsuspend/SSL changes). */
export async function applyAccountWeb(userId: number) {
  const user = one<UserRow>('SELECT * FROM users WHERE id = ?', userId);
  if (!user) return;
  if (user.status === 'suspended') {
    await removePath(fpmPoolPath(user.username));
  } else {
    await writeAtomic(fpmPoolPath(user.username), renderFpmPool(user.username));
  }
  for (const d of all<DomainRow>('SELECT * FROM domains WHERE user_id = ?', userId)) {
    await writeVhost(d, user);
  }
  await writeIpSites();
  // Order matters so requests never reach a PHP pool that's gone: when suspending, nginx
  // switches to the suspended page before the pool is removed; when restoring, the pool
  // starts before nginx sends traffic to it.
  if (user.status === 'suspended') {
    await reloadNginx();
    await reloadFpm();
  } else {
    await reloadFpm();
    await reloadNginx();
  }
}
