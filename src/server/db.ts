import { Pool, types, type PoolClient, type QueryResultRow } from 'pg';

types.setTypeParser(1082, value => value);

const globalDb = globalThis as unknown as { invoixPool?: Pool };

export function pool(): Pool {
  if (!globalDb.invoixPool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    globalDb.invoixPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      // Use sslmode=verify-full and sslrootcert in DATABASE_URL for remote databases.
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
export async function rows<T extends QueryResultRow = Row>(sql: string, values: unknown[] = [], db: DB = pool()): Promise<T[]> {
  return (await db.query<T>(sql, values)).rows;
}
export async function transaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

type Table = 'users' | 'buyers' | 'suppliers' | 'programmes' | 'invoices' | 'bids';
// Table and field names come exclusively from service-owned allowlists.
function identifier(name: string) {
  if (!/^[a-z_]+$/.test(name)) throw new Error('Invalid SQL identifier');
  return `"${name}"`;
}
export async function insert(table: Table, data: Record<string, unknown>, db: DB): Promise<Row> {
  const keys = Object.keys(data);
  const [record] = await rows(`INSERT INTO ${identifier(table)} (${keys.map(identifier).join(',')}, created_at, updated_at)
    VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}, now(), now()) RETURNING *`, Object.values(data), db);
  return record;
}
export async function update(table: Table, id: string, data: Record<string, unknown>, db: DB): Promise<Row> {
  const keys = Object.keys(data);
  const [record] = await rows(`UPDATE ${identifier(table)} SET ${keys.map((key, i) => `${identifier(key)}=$${i + 2}`).concat('updated_at=now()').join(',')}
    WHERE id=$1 RETURNING *`, [id, ...Object.values(data)], db);
  return record;
}
