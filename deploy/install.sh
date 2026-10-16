#!/usr/bin/env bash
# VEXPANEL installer for a fresh Ubuntu 24.04 server.
#
#   sudo VEX_HOSTNAME=srv1.example.com VEX_ADMIN_EMAIL=you@example.com \
#        VEX_NAMESERVERS=ns1.example.com,ns2.example.com ./deploy/install.sh
#
# Run it from a checkout of the repository. It installs and configures:
#   nginx + PHP-FPM, MariaDB, Postfix + Dovecot, BIND, certbot, and the panel itself.
# Re-running is safe: existing config written by this script is replaced, data is kept.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "Run as root (sudo)." >&2; exit 1; fi
. /etc/os-release
if [[ "${ID}" != "ubuntu" || "${VERSION_ID}" != "24.04" ]]; then
  echo "This installer targets Ubuntu 24.04 (found ${PRETTY_NAME}). Set VEX_FORCE=1 to continue anyway." >&2
  [[ "${VEX_FORCE:-}" == "1" ]] || exit 1
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/vexpanel
ETC_DIR=/etc/vexpanel
DATA_DIR=/var/lib/vexpanel
PHP_VERSION="${VEX_PHP_VERSION:-8.3}"
HOSTNAME_FQDN="${VEX_HOSTNAME:-$(hostname -f)}"
ADMIN_EMAIL="${VEX_ADMIN_EMAIL:-admin@${HOSTNAME_FQDN}}"
NAMESERVERS="${VEX_NAMESERVERS:-ns1.${HOSTNAME_FQDN#*.},ns2.${HOSTNAME_FQDN#*.}}"
SERVER_IP="${VEX_SERVER_IP:-$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')}"
SERVER_IPV6="${VEX_SERVER_IPV6:-}"
PANEL_PORT=2083

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }

log "Installing packages"
export DEBIAN_FRONTEND=noninteractive
echo "postfix postfix/main_mailer_type select Internet Site" | debconf-set-selections
echo "postfix postfix/mailname string ${HOSTNAME_FQDN}" | debconf-set-selections
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg acl quota openssl ssl-cert openssh-server iproute2 cron \
  nginx "php${PHP_VERSION}-fpm" "php${PHP_VERSION}"-{mysql,curl,gd,mbstring,xml,zip,intl,bcmath,imagick} \
  mariadb-server postfix dovecot-imapd dovecot-lmtpd bind9 bind9-utils certbot

if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  log "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi

log "Users and groups"
getent group vexusers >/dev/null || groupadd vexusers
getent group vmail >/dev/null || groupadd -g 5000 vmail
getent passwd vmail >/dev/null || useradd -u 5000 -g vmail -d /var/vmail -s /usr/sbin/nologin -M vmail
install -d -o vmail -g vmail -m 0770 /var/vmail

# Hosting accounts get SFTP only, locked to their home directory by file permissions.
install -d -m 0755 /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/50-vexpanel.conf <<'EOF'
# Managed by VEXPANEL
Match Group vexusers
    ForceCommand internal-sftp
    PasswordAuthentication yes
    AllowTcpForwarding no
    X11Forwarding no
    PermitTunnel no
EOF
sshd -t && systemctl reload ssh || true

log "MariaDB"
systemctl enable --now mariadb
mkdir -p "$ETC_DIR" && chmod 700 "$ETC_DIR"
if [[ ! -f "$ETC_DIR/mysql.pass" ]]; then
  openssl rand -base64 30 | tr -d '\n/+=' > "$ETC_DIR/mysql.pass"
  chmod 600 "$ETC_DIR/mysql.pass"
fi
MYSQL_PASS="$(cat "$ETC_DIR/mysql.pass")"
mariadb <<SQL
CREATE USER IF NOT EXISTS 'vexpanel'@'localhost' IDENTIFIED BY '${MYSQL_PASS}';
ALTER USER 'vexpanel'@'localhost' IDENTIFIED BY '${MYSQL_PASS}';
GRANT ALL PRIVILEGES ON *.* TO 'vexpanel'@'localhost' WITH GRANT OPTION;
FLUSH PRIVILEGES;
SQL

log "nginx and PHP-FPM"
LISTEN_V6=""
if [[ -f /proc/net/if_inet6 ]]; then
  LISTEN_V6="    listen [::]:${PANEL_PORT} ssl http2;"
else
  # IPv6 is disabled on this host; nginx refuses to start with [::] listeners.
  sed -i 's/^\(\s*\)listen \[::\]/\1# listen [::]/' /etc/nginx/sites-available/default 2>/dev/null || true
fi
install -d -m 0755 /etc/nginx/vexpanel /var/log/nginx/vexpanel
cat > /etc/nginx/conf.d/vexpanel.conf <<EOF
# Managed by VEXPANEL
server_names_hash_bucket_size 128;
include /etc/nginx/vexpanel/*.conf;

# The panel itself, on port ${PANEL_PORT} with TLS.
server {
    listen ${PANEL_PORT} ssl http2;
${LISTEN_V6}
    server_name _;
    ssl_certificate     ${ETC_DIR}/panel.crt;
    ssl_certificate_key ${ETC_DIR}/panel.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 512m;
    proxy_request_buffering off;

    location / {
        proxy_pass http://127.0.0.1:2086;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 300s;
    }
}
EOF
# Self-signed panel certificate until one is issued for the hostname (see README).
if [[ ! -f "$ETC_DIR/panel.crt" ]]; then
  ln -sf /etc/ssl/certs/ssl-cert-snakeoil.pem "$ETC_DIR/panel.crt"
  ln -sf /etc/ssl/private/ssl-cert-snakeoil.key "$ETC_DIR/panel.key"
fi
rm -f /etc/php/${PHP_VERSION}/fpm/pool.d/www.conf.disabled
nginx -t
systemctl enable --now nginx "php${PHP_VERSION}-fpm"
systemctl reload nginx

install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/vexpanel-reload.sh <<'EOF'
#!/bin/sh
systemctl reload nginx
EOF
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/vexpanel-reload.sh

log "BIND"
touch /etc/bind/named.conf.vexpanel
install -d -o root -g bind -m 0750 /etc/bind/vexpanel
grep -q 'named.conf.vexpanel' /etc/bind/named.conf.local || echo 'include "/etc/bind/named.conf.vexpanel";' >> /etc/bind/named.conf.local
named-checkconf
systemctl enable --now named
systemctl reload named || true

log "Postfix and Dovecot"
install -d -m 0755 /etc/postfix/vexpanel
for m in vdomains vmailbox valias; do
  [[ -f /etc/postfix/vexpanel/$m ]] || touch /etc/postfix/vexpanel/$m
  postmap /etc/postfix/vexpanel/$m
done
postconf -e \
  "myhostname = ${HOSTNAME_FQDN}" \
  "mydestination = localhost" \
  "virtual_mailbox_domains = hash:/etc/postfix/vexpanel/vdomains" \
  "virtual_mailbox_maps = hash:/etc/postfix/vexpanel/vmailbox" \
  "virtual_alias_maps = hash:/etc/postfix/vexpanel/valias" \
  "virtual_transport = lmtp:unix:private/dovecot-lmtp" \
  "smtpd_sasl_type = dovecot" \
  "smtpd_sasl_path = private/auth" \
  "smtpd_sasl_auth_enable = yes" \
  "smtpd_tls_cert_file = /etc/ssl/certs/ssl-cert-snakeoil.pem" \
  "smtpd_tls_key_file = /etc/ssl/private/ssl-cert-snakeoil.key" \
  "smtpd_tls_security_level = may" \
  "smtp_tls_security_level = may" \
  "smtpd_recipient_restrictions = permit_sasl_authenticated, permit_mynetworks, reject_unauth_destination" \
  "message_size_limit = 52428800"
postconf -M submission/inet="submission inet n - y - - smtpd"
postconf -P "submission/inet/syslog_name=postfix/submission" \
  "submission/inet/smtpd_tls_security_level=encrypt" \
  "submission/inet/smtpd_sasl_auth_enable=yes" \
  "submission/inet/smtpd_client_restrictions=permit_sasl_authenticated,reject"

touch /etc/dovecot/vexpanel-users
chgrp dovecot /etc/dovecot/vexpanel-users && chmod 640 /etc/dovecot/vexpanel-users
cat > /etc/dovecot/conf.d/99-vexpanel.conf <<'EOF'
# Managed by VEXPANEL
protocols = imap lmtp
auth_mechanisms = plain login
disable_plaintext_auth = yes
mail_location = maildir:~
mail_plugins = $mail_plugins quota
first_valid_uid = 5000
last_valid_uid = 5000

passdb {
  driver = passwd-file
  args = scheme=SSHA512 username_format=%u /etc/dovecot/vexpanel-users
}
userdb {
  driver = passwd-file
  args = username_format=%u /etc/dovecot/vexpanel-users
}

plugin {
  quota = maildir:User quota
}

service lmtp {
  unix_listener /var/spool/postfix/private/dovecot-lmtp {
    mode = 0600
    user = postfix
    group = postfix
  }
}
service auth {
  unix_listener /var/spool/postfix/private/auth {
    mode = 0660
    user = postfix
    group = postfix
  }
}
protocol imap {
  mail_plugins = $mail_plugins imap_quota
}
ssl = required
ssl_cert = </etc/ssl/certs/ssl-cert-snakeoil.pem
ssl_key = </etc/ssl/private/ssl-cert-snakeoil.key
EOF
# Ubuntu's 10-auth.conf enables system users by default; panel mailboxes use the passwd-file only.
sed -i 's/^!include auth-system.conf.ext/#!include auth-system.conf.ext/' /etc/dovecot/conf.d/10-auth.conf
if [[ ! -f /proc/net/if_inet6 ]]; then
  echo 'listen = *' >> /etc/dovecot/conf.d/99-vexpanel.conf
  postconf -e "inet_protocols = ipv4"
fi
doveconf -n >/dev/null
systemctl enable --now postfix dovecot
systemctl restart postfix dovecot

log "Installing the panel to ${APP_DIR}"
install -d -m 0755 "$APP_DIR"
cp -a "$SRC_DIR"/{package.json,package-lock.json,tsconfig.server.json,src,web} "$APP_DIR"/
cd "$APP_DIR"
npm ci --no-audit --no-fund
npm run build
npm prune --omit=dev --no-audit --no-fund
chmod -R a+rX "$APP_DIR"

install -d -m 0700 "$DATA_DIR"
install -d -m 0755 "$DATA_DIR/suspended"
cat > "$DATA_DIR/suspended/index.html" <<'EOF'
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Account suspended</title>
<style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#eef1f4;color:#1b2333}main{max-width:36ch;text-align:center}</style></head>
<body><main><h1>This site is unavailable</h1><p>The hosting account for this website is suspended. If you own it, contact your hosting provider.</p></main></body></html>
EOF
# nginx (www-data) must be able to reach the suspended page.
chmod 711 "$DATA_DIR"

ENV_FILE="$ETC_DIR/vexpanel.env"
cat > "$ENV_FILE" <<EOF
VEX_HOST=127.0.0.1
VEX_PORT=2086
VEX_DATA_DIR=${DATA_DIR}
VEX_HOSTNAME=${HOSTNAME_FQDN}
VEX_SERVER_IP=${SERVER_IP}
VEX_SERVER_IPV6=${SERVER_IPV6}
VEX_NAMESERVERS=${NAMESERVERS}
VEX_ADMIN_EMAIL=${ADMIN_EMAIL}
VEX_PHP_VERSION=${PHP_VERSION}
VEX_MYSQL_USER=vexpanel
VEX_MYSQL_PASSWORD=${MYSQL_PASS}
EOF
chmod 600 "$ENV_FILE"

install -m 0644 "$SRC_DIR/deploy/vexpanel.service" /etc/systemd/system/vexpanel.service
cat > /usr/local/bin/vexpanel <<EOF
#!/bin/sh
set -a; . ${ENV_FILE}; set +a
exec node --disable-warning=ExperimentalWarning ${APP_DIR}/dist/server/cli.js "\$@"
EOF
chmod 755 /usr/local/bin/vexpanel

systemctl enable --now cron
systemctl daemon-reload
systemctl enable vexpanel
systemctl restart vexpanel

if command -v ufw >/dev/null && ufw status | grep -q active; then
  log "Opening firewall ports"
  for p in 22 25 53 80 443 587 993 ${PANEL_PORT}; do ufw allow "$p" >/dev/null; done
  ufw allow 53/udp >/dev/null
fi

for _ in $(seq 1 20); do
  curl -fsS http://127.0.0.1:2086/api/health >/dev/null 2>&1 && break
  sleep 1
done

log "Done"
echo "Panel:        https://${HOSTNAME_FQDN}:${PANEL_PORT}   (self-signed certificate until you issue one)"
if [[ -f "$DATA_DIR/initial-admin.txt" ]]; then
  echo "First login:  $(tr '\n' ' ' < "$DATA_DIR/initial-admin.txt")"
  echo "              Change it after signing in, then delete $DATA_DIR/initial-admin.txt"
fi
echo "Nameservers:  ${NAMESERVERS} → register these as glue records pointing at ${SERVER_IP}"
echo "Disk quotas:  add usrquota to the /home mount in /etc/fstab, remount, then run quotacheck -cum /home && quotaon /home"
