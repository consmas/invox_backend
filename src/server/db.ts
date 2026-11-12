import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, types, type PoolClient, type QueryResultRow } from 'pg';

types.setTypeParser(1082, value => value);

const globalDb = globalThis as unknown as { invoixPool?: Pool; invoixTx?: AsyncLocalStorage<TxState> };
type TxState = { client: PoolClient; depth: number };
// The active transaction follows the async call chain, so helpers that open a "transaction" while one is
// already running reuse the same connection (with a savepoint) instead of waiting for a second pool client.
const tx = globalDb.invoixTx ??= new AsyncLocalStorage<TxState>();

// Accepts the PEM pasted directly or with escaped newlines, as hosting dashboards often store it.
function caCertificate(raw: string): string {
  const pem = raw.trim().replace(/^DATABASE_CA_CERT=/, '').replace(/^["']|["']$/g, '').replace(/\\n/g, '\n');
  if (!pem.includes('-----BEGIN CERTIFICATE-----')) throw new Error('DATABASE_CA_CERT must contain a PEM certificate');
  return pem;
}

// DATABASE_CA_CERT (PEM contents) suits platforms without a writable cert file; pg lets
// connection-string ssl params override the ssl option, so they are removed when it is set.
function connectionConfig(url: string) {
  const ca = process.env.DATABASE_CA_CERT;
  if (!ca) return { connectionString: url };
  const parsed = new URL(url);
  for (const key of ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey']) parsed.searchParams.delete(key);
  return { connectionString: parsed.toString(), ssl: { ca: caCertificate(ca), rejectUnauthorized: true } };
}
const setting = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

export function pool(): Pool {
  if (!globalDb.invoixPool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    globalDb.invoixPool = new Pool({
      ...connectionConfig(process.env.DATABASE_URL),
      max: setting('DATABASE_POOL_MAX', 10),
      connectionTimeoutMillis: setting('DATABASE_CONNECT_TIMEOUT_MS', 5000),
      idleTimeoutMillis: 30000,
      // Server-side deadlines stop slow queries, lock waits and abandoned transactions from holding connections.
      statement_timeout: setting('DATABASE_STATEMENT_TIMEOUT_MS', 15000),
      lock_timeout: setting('DATABASE_LOCK_TIMEOUT_MS', 5000),
      idle_in_transaction_session_timeout: setting('DATABASE_IDLE_TX_TIMEOUT_MS', 30000),
      // Remote databases: set DATABASE_CA_CERT, or sslmode=verify-full&sslrootcert=<file path> in DATABASE_URL.
    });
    globalDb.invoixPool.on('error', error => console.error('PostgreSQL pool error', error.message));
  }
  return globalDb.invoixPool;
}

// CLI cleanup must not create a pool when configuration or validation failed before connecting.
export async function closePool(): Promise<void> {
  const existing=globalDb.invoixPool;
  if(!existing)return;
  delete globalDb.invoixPool;
  await existing.end();
}

export type DB = Pool | PoolClient;
export type Row = QueryResultRow;
/** Without an explicit client, queries join the caller's transaction so business writes and audit events commit together. */
export async function rows<T extends QueryResultRow = Row>(sql: string, values: unknown[] = [], db?: DB): Promise<T[]> {
  return (await (db ?? tx.getStore()?.client ?? pool()).query<T>(sql, values)).rows;
}
export async function transaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
  const outer = tx.getStore();
  if (outer) {
    const savepoint = `nested_${++outer.depth}`;
    await outer.client.query(`SAVEPOINT ${savepoint}`);
    try {
      const result = await work(outer.client);
      await outer.client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      await outer.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => undefined);
      throw error;
    } finally { outer.depth--; }
  }
  const client = await pool().connect();
  let broken = false;
  try {
    return await tx.run({ client, depth: 0 }, async () => {
      await client.query('BEGIN');
      try {
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => { broken = true; });
        throw error;
      }
    });
  } finally { client.release(broken); }
}

type Table = 'users' | 'buyers' | 'suppliers' | 'programmes' | 'invoices' | 'bids';
// Table and field names come exclusively from service-owned allowlists.
function identifier(name: string) {
  if (!/^[a-z_]+$/.test(name)) throw new Error('Invalid SQL identifier');
  return `"${name}"`;
}
export async function insert(table: Table, data: Record<string, unknown>, db?: DB): Promise<Row> {
  const keys = Object.keys(data);
  const [record] = await rows(`INSERT INTO ${identifier(table)} (${keys.map(identifier).join(',')}, created_at, updated_at)
    VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}, now(), now()) RETURNING *`, Object.values(data), db);
  return record;
}
export async function update(table: Table, id: string, data: Record<string, unknown>, db?: DB): Promise<Row> {
  const keys = Object.keys(data);
  const [record] = await rows(`UPDATE ${identifier(table)} SET ${keys.map((key, i) => `${identifier(key)}=$${i + 2}`).concat('updated_at=now()').join(',')}
    WHERE id=$1 RETURNING *`, [id, ...Object.values(data)], db);
  return record;
}
