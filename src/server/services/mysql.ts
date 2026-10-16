import mysql from 'mysql2/promise';
import { config } from '../config.js';
import { dryLog } from '../sys/exec.js';
import { SysError } from '../errors.js';

let pool: mysql.Pool | null = null;

function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      socketPath: config.mysql.socketPath,
      user: config.mysql.user,
      password: config.mysql.password,
      connectionLimit: 4,
      multipleStatements: false,
    });
  }
  return pool;
}

/** Identifiers have already been validated to [a-z0-9_]; backtick-quote them for DDL. */
const ident = (s: string) => {
  if (!/^[a-z0-9_]{1,64}$/.test(s)) throw new SysError(`Unsafe identifier: ${s}`);
  return `\`${s}\``;
};

async function q(sql: string, params: unknown[] = [], logSql = sql) {
  if (config.dryRun) {
    dryLog(`mysql> ${logSql}`);
    return;
  }
  try {
    await getPool().query(sql, params);
  } catch (err) {
    throw new SysError('MariaDB rejected the change', (err as Error).message);
  }
}

export const createDatabase = (name: string) =>
  q(`CREATE DATABASE ${ident(name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

export const dropDatabase = (name: string) => q(`DROP DATABASE IF EXISTS ${ident(name)}`);

export const createUser = (name: string, password: string) =>
  q('CREATE USER ?@? IDENTIFIED BY ?', [name, 'localhost', password], `CREATE USER '${name}'@'localhost' IDENTIFIED BY '***'`);

export const setUserPassword = (name: string, password: string) =>
  q('ALTER USER ?@? IDENTIFIED BY ?', [name, 'localhost', password], `ALTER USER '${name}'@'localhost' IDENTIFIED BY '***'`);

export const dropUser = (name: string) => q('DROP USER IF EXISTS ?@?', [name, 'localhost'], `DROP USER IF EXISTS '${name}'@'localhost'`);

export const grantAll = (db: string, user: string) =>
  q(`GRANT ALL PRIVILEGES ON ${ident(db)}.* TO ?@?`, [user, 'localhost'], `GRANT ALL PRIVILEGES ON \`${db}\`.* TO '${user}'@'localhost'`);

export const revokeAll = (db: string, user: string) =>
  q(`REVOKE ALL PRIVILEGES ON ${ident(db)}.* FROM ?@?`, [user, 'localhost'], `REVOKE ALL PRIVILEGES ON \`${db}\`.* FROM '${user}'@'localhost'`);

/** Lock or unlock all of an account's database users (used when suspending). */
export async function setUsersLocked(names: string[], locked: boolean) {
  for (const n of names) {
    await q(`ALTER USER ?@? ACCOUNT ${locked ? 'LOCK' : 'UNLOCK'}`, [n, 'localhost'], `ALTER USER '${n}'@'localhost' ACCOUNT ${locked ? 'LOCK' : 'UNLOCK'}`);
  }
}

/** Size of each database in bytes. */
export async function databaseSizes(names: string[]): Promise<Record<string, number>> {
  if (config.dryRun || names.length === 0) return {};
  try {
    const [rows] = await getPool().query(
      'SELECT table_schema AS db, SUM(data_length + index_length) AS bytes FROM information_schema.tables WHERE table_schema IN (?) GROUP BY table_schema',
      [names],
    );
    return Object.fromEntries((rows as Array<{ db: string; bytes: string }>).map((r) => [r.db, Number(r.bytes)]));
  } catch {
    return {};
  }
}

export async function closeMysql() {
  await pool?.end();
}
