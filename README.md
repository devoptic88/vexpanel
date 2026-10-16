# VEXPANEL

A self-hosted web hosting control panel for Ubuntu 24.04 — the same job cPanel/WHM does, as one open Node.js service.

- **Admin side (WHM-style):** server health, hosting packages, create / suspend / terminate accounts, "log in as" any account, activity log.
- **Account side (cPanel-style):** domains and subdomains, file manager, MariaDB databases and users, mailboxes and forwarders, DNS zone editor, Let's Encrypt certificates, cron jobs.

It drives the standard Ubuntu stack directly — nginx + PHP-FPM, MariaDB, Postfix + Dovecot, BIND 9 and certbot — so everything it configures is plain config you can read under `/etc`.

## Install on a server

On a fresh Ubuntu 24.04 VPS, as root:

```bash
git clone https://github.com/devoptic88/vexpanel.git
cd vexpanel
sudo VEX_HOSTNAME=srv1.example.com \
     VEX_ADMIN_EMAIL=you@example.com \
     VEX_NAMESERVERS=ns1.example.com,ns2.example.com \
     ./deploy/install.sh
```

When it finishes it prints the panel URL (`https://<hostname>:2083`) and the first admin password (also saved to `/var/lib/vexpanel/initial-admin.txt`).

Then:

1. **Nameservers.** At your registrar, create glue records `ns1`/`ns2` pointing to the server IP, and point customer domains at those nameservers. BIND on this server answers for every hosted zone.
2. **Disk quotas (optional).** Add `usrquota` to the `/home` mount in `/etc/fstab`, remount, then `quotacheck -cum /home && quotaon /home`. Without this, package disk limits are shown but not enforced.
3. **Panel certificate.** The panel starts with a self-signed certificate. Once the hostname resolves, issue one with certbot and point `/etc/vexpanel/panel.crt` and `panel.key` at it.

Re-running the installer upgrades the panel in place and keeps all data.

### Ports

| Port | Use |
|---|---|
| 2083 | Panel (HTTPS) |
| 80 / 443 | Websites |
| 53 tcp+udp | DNS |
| 25, 587 | SMTP, submission |
| 993 | IMAP over TLS |
| 22 | SFTP for hosting accounts |

## How it works

```
 browser ──https:2083──▶ nginx ──▶ VEXPANEL (127.0.0.1:2086, root)
                                     │  SQLite: accounts, domains, records, mailboxes…
                                     │
                                     ├─ useradd / chpasswd / crontab        (Linux accounts, SFTP, cron)
                                     ├─ /etc/nginx/vexpanel/*.conf          (vhosts, nginx -t before reload)
                                     ├─ /etc/php/8.3/fpm/pool.d/vex-*.conf  (one PHP pool per account, runs as that user)
                                     ├─ MariaDB (vexpanel admin user)       (databases, users, grants)
                                     ├─ /etc/bind/vexpanel/db.*             (zones, named-checkzone before reload)
                                     ├─ /etc/postfix/vexpanel/* + Dovecot   (virtual mailboxes, forwarders)
                                     ├─ certbot --webroot                   (Let's Encrypt)
                                     └─ file worker (spawned as the account's uid)
```

The database is the source of truth. Every service config is re-rendered from it, validated, and only then reloaded; if validation fails, the previous file is restored. `vexpanel rebuild` regenerates everything from the database.

### Security model

- **Per-account isolation.** Each account is a Linux user with a `nologin` shell, SFTP only (`Match Group vexusers` → `internal-sftp`), home `711`, web roots `2750` owned by the user with the `www-data` group. PHP runs in a dedicated FPM pool as that user with `open_basedir` set to the home folder and shell-exec functions disabled.
- **File manager never touches customer files as root.** Each operation runs in a short-lived worker process with the account's uid/gid, so the kernel enforces permissions; symlinks pointing outside the home folder are rejected.
- **No shell interpolation.** System commands are run with argument arrays (`execFile`), and all names (users, domains, DB names, DNS records, cron lines) are validated before they reach a config file.
- **Sessions.** bcrypt passwords, random session tokens stored hashed, `HttpOnly` + `SameSite=Strict` cookies, double-submit CSRF token on every state-changing request, rate-limited login, all changes in the activity log.
- **Suspension** locks the Linux account, kills its processes, swaps its sites to a suspended page, removes its PHP pool, disables its cron, blocks mailbox login (mail still arrives), and locks its database users.

The panel process itself runs as root, like cPanel's. Put port 2083 behind a firewall allow-list if you can.

## CLI

```bash
vexpanel reset-admin-password [username]   # prints a new random password
vexpanel rebuild                            # re-render all vhosts, zones, mail maps and crontabs
```

## Development

Requires Node.js 22.13+. Dry-run mode runs no system commands and writes every generated config under `.data/dryroot/`, so you can develop on a laptop:

```bash
npm install
npm run dev          # API on :2086 + Vite UI on :5173 (proxying /api)
```

The first run prints the admin password and saves it to `.data/initial-admin.txt`. Generated nginx, BIND, Postfix and PHP-FPM files appear under `.data/dryroot/etc/…`, and every command that would have run is logged to `.data/dryrun.log`.

```bash
npm test             # renderer/validator unit tests + a full API lifecycle in dry-run
npm run typecheck
npm run build        # dist/server + dist/web
```

### Layout

```
src/server/
  index.ts            Fastify app, error handling, static UI
  auth.ts             sessions, CSRF, roles
  db.ts               SQLite schema and helpers
  validate.ts         input validation for everything that reaches a config file
  routes/             auth, admin, account-side API
  services/           accounts, web (nginx/php-fpm), dns, mail, mysql, ssl, cron, files
  sys/                exec (no-shell runner + lock), fsx (atomic/checked writes), fsworker (per-user file ops)
web/src/              React UI
deploy/               install.sh, systemd unit
test/                 node:test suites
```

## Not built yet

Things cPanel has that this first version doesn't: backups and restores, phpMyAdmin / webmail links, bandwidth accounting, DKIM signing, spam filtering, multiple PHP versions per domain, resellers, a billing/WHMCS-style module, and extracting archives in the file manager.

## License

MIT
