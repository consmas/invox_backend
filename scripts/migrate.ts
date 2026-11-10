import { loadEnvConfig } from '@next/env';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { closePool, rows, transaction } from '../src/server/db';

loadEnvConfig(process.cwd());
async function migrate() {
  await transaction(async db => {
    await db.query('SELECT pg_advisory_xact_lock(72482901)');
    await db.query('CREATE TABLE IF NOT EXISTS app_migrations (name varchar PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const directory = resolve(process.cwd(),'db/migrations');
    for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
      if ((await rows('SELECT name FROM app_migrations WHERE name=$1',[name],db)).length) continue;
      await db.query(await readFile(resolve(directory,name),'utf8'));
      await db.query('INSERT INTO app_migrations (name) VALUES ($1)',[name]);
      console.log(`Applied ${name}`);
    }
  });
}
migrate().catch(error => { console.error(error.message); process.exitCode=1; }).finally(closePool);
