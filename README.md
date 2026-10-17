# VEXPANEL

A self-hosted web hosting control panel for Ubuntu 24.04 — the same job cPanel/WHM does, as one open Node.js service.

- **Admin side (WHM-style):** server health, hosting packages, create / suspend / terminate accounts, "log in as" any account, activity log.
- **Account side (cPanel-style):** one-click app installer, domains and subdomains, file manager, MariaDB databases and users, mailboxes and forwarders, DNS zone editor, Let's Encrypt certificates, cron jobs.
- **No domain needed to start:** every account's site is also reachable at `http://<server-ip>/~username/`.

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

## App installer

The **Apps** page installs web apps into any domain (or the IP preview) and folder. The server downloads the current release itself, unpacks it as the account's own Linux user, and creates a database and database user when the app needs one.

| App | Setup |
|---|---|
| WordPress, phpBB | Fully automatic: site title and admin account are set from the install form |
| phpMyAdmin | Configured automatically; sign in with a database user |
| MyBB, Simple Machines Forum, Joomla, Drupal, Matomo | Files and database prepared; finish on the app's own setup page with the database details the panel shows |
| DokuWiki | Files prepared; finish on its setup page (no database) |
| Upload your own | vBulletin, XenForo, Invision Community or any licensed PHP app: upload its .zip/.tar.gz in the file manager, then install it from there |

Apps can be nested (a blog at the root, a forum in `/forum`). Removing an app deletes its files and, optionally, its database; apps in its subfolders are kept.

Download sources are resolved at install time (WordPress, Drupal, DokuWiki, Matomo and phpMyAdmin "latest" links; GitHub's latest release for MyBB and SMF; phpBB's version feed). Joomla is pinned to a version. To pin a version or use a mirror, override any app in `/etc/vexpanel/apps.json`:

```json
{ "joomla": { "source": { "type": "url", "url": "https://downloads.joomla.org/…/Joomla_6-2-0-Stable-Full_Package.zip?format=zip" } } }
```

## IP preview

Before a domain points at the server, each account's main site is served at `http://<server-ip>/~username/`, with PHP running in that account's own pool. All accounts share the IP's origin (and its cookies), so treat it as a preview and testing address; use a real domain for production sites. Apps installed "on the server IP" store that address as their site URL.

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

Things cPanel has that this version doesn't: backups and restores, webmail, bandwidth accounting, DKIM signing, spam filtering, multiple PHP versions per domain, resellers, a billing/WHMCS-style module, app updates from the panel, and extracting archives in the file manager.

## License

MIT
