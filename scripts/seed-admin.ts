import { loadEnvConfig } from '@next/env';
import { randomUUID } from 'node:crypto';
import { closePool, rows, insert, transaction } from '../src/server/db';
import { hashPassword } from '../src/server/auth';
import { email, password } from '../src/server/validation';
import { z } from 'zod';

// Load .env.production only when NODE_ENV=production; local runs use .env.local / .env.development.
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');
async function seed() {
  const missing=['ADMIN_EMAIL','ADMIN_PASSWORD'].filter(key=>!process.env[key]?.trim());
  if(missing.length)throw new Error(`Set ${missing.join(' and ')} in nbackend/.env.local or your shell environment before running pnpm db:seed-admin.`);
  const credentials=z.object({ADMIN_EMAIL:email,ADMIN_PASSWORD:password}).safeParse(process.env);
  if(!credentials.success)throw new Error(credentials.error.issues.map(issue=>`${issue.path.join('.')}: ${issue.message}`).join('; '));
  const address=credentials.data.ADMIN_EMAIL;
  const secret=credentials.data.ADMIN_PASSWORD;
  await transaction(async db => {
    await db.query('SELECT pg_advisory_xact_lock(72482902)');
    const [existing] = await rows('SELECT role FROM users WHERE lower(email)=$1',[address],db);
    if (existing) {
      if (existing.role !== 2) throw new Error('Email already belongs to another role; no changes made');
      console.log('Platform operator already exists; password unchanged');
      return;
    }
    await insert('users',{email:address,encrypted_password:await hashPassword(secret),role:2,jti:randomUUID()},db);
    console.log('Created platform operator');
  });
}
seed().catch(error => { console.error(error.message); process.exitCode=1; }).finally(closePool);
