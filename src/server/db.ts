import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

const dbFile = path.join(config.dataDir, 'vexpanel.db');
export const db = new DatabaseSync(dbFile);
// Holds password hashes and session tokens: root-only. SQLite gives -wal/-shm the same mode.
chmodSync(dbFile, 0o600);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const migrations: string[] = [
  `
  CREATE TABLE packages (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    disk_mb INTEGER NOT NULL DEFAULT 1024,
    max_addon_domains INTEGER NOT NULL DEFAULT 0,
    max_subdomains INTEGER NOT NULL DEFAULT 10,
    max_databases INTEGER NOT NULL DEFAULT 2,
    max_email_accounts INTEGER NOT NULL DEFAULT 10,
    max_cron_jobs INTEGER NOT NULL DEFAULT 10,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','user')),
    email TEXT NOT NULL DEFAULT '',
    package_id INTEGER REFERENCES packages(id),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
    uid INTEGER,
    gid INTEGER,
    disk_used_bytes INTEGER NOT NULL DEFAULT 0,
    disk_checked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    impersonated_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    ip TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE domains (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK (type IN ('main','addon','sub')),
    parent_id INTEGER REFERENCES domains(id) ON DELETE CASCADE,
    docroot TEXT NOT NULL,
    ssl INTEGER NOT NULL DEFAULT 0,
    ssl_expires TEXT,
    dns_serial INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE dns_records (
    id INTEGER PRIMARY KEY,
    domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    value TEXT NOT NULL,
    ttl INTEGER NOT NULL DEFAULT 3600,
    priority INTEGER
  );

  CREATE TABLE databases (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE db_users (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE db_grants (
    database_id INTEGER NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
    db_user_id INTEGER NOT NULL REFERENCES db_users(id) ON DELETE CASCADE,
    PRIMARY KEY (database_id, db_user_id)
  );

  CREATE TABLE mail_accounts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    local_part TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    quota_mb INTEGER NOT NULL DEFAULT 1024,
    UNIQUE (domain_id, local_part)
  );

  CREATE TABLE mail_forwarders (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    local_part TEXT NOT NULL,
    destination TEXT NOT NULL,
    UNIQUE (domain_id, local_part, destination)
  );

  CREATE TABLE cron_jobs (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    schedule TEXT NOT NULL,
    command TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  INSERT INTO packages (name, disk_mb, max_addon_domains, max_subdomains, max_databases, max_email_accounts, max_cron_jobs)
  VALUES ('Starter', 2048, 0, 5, 2, 5, 5),
         ('Business', 10240, 5, 25, 10, 50, 20),
         ('Unlimited', 51200, 1000, 1000, 1000, 1000, 1000);
  `,
];

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let current = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  while (current < migrations.length) {
    db.exec('BEGIN');
    try {
      db.exec(migrations[current]);
      current += 1;
      db.prepare('UPDATE schema_version SET version = ?').run(current);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
migrate();

/** Run fn inside a transaction. */
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function one<T>(sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}

export function all<T>(sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

export function exec(sql: string, ...params: unknown[]): { lastInsertRowid: number; changes: number } {
  const r = db.prepare(sql).run(...(params as never[]));
  return { lastInsertRowid: Number(r.lastInsertRowid), changes: Number(r.changes) };
}

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: 'admin' | 'user';
  email: string;
  package_id: number | null;
  status: 'active' | 'suspended';
  uid: number | null;
  gid: number | null;
  disk_used_bytes: number;
  disk_checked_at: string | null;
  created_at: string;
}

export interface PackageRow {
  id: number;
  name: string;
  disk_mb: number;
  max_addon_domains: number;
  max_subdomains: number;
  max_databases: number;
  max_email_accounts: number;
  max_cron_jobs: number;
}

export interface DomainRow {
  id: number;
  user_id: number;
  name: string;
  type: 'main' | 'addon' | 'sub';
  parent_id: number | null;
  docroot: string;
  ssl: number;
  ssl_expires: string | null;
  dns_serial: number;
}

export interface DnsRecordRow {
  id: number;
  domain_id: number;
  name: string;
  type: string;
  value: string;
  ttl: number;
  priority: number | null;
}

export function audit(actor: string, action: string, detail = '', ip = '') {
  exec('INSERT INTO audit_log (actor, action, detail, ip) VALUES (?, ?, ?, ?)', actor, action, detail, ip);
}
