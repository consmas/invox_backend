// Integration settings: super administrator only, credentials write-only and sealed, keys must match the mode,
// payment routing only to switched-on providers, and connection tests against the providers' APIs.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import { NextRequest } from 'next/server';
import { handleRequest } from '../src/server/http';
import { pool, rows, insert, transaction } from '../src/server/db';
import { sendSms, smsNumber } from '../src/server/integrations';

const connection = process.env.TEST_DATABASE_URL;
if (!connection || !new URL(connection).pathname.endsWith('_test')) throw new Error('Set TEST_DATABASE_URL to an isolated PostgreSQL database ending in _test.');
const admin = new Pool({ connectionString: connection });
const schema = `integrations_test_${process.pid}_${Date.now()}`;
const url = new URL(connection);
url.searchParams.set('options', `-c search_path=${schema}`);
Object.assign(process.env, { DATABASE_URL: url.toString(), APP_URL: 'http://localhost:3000', NODE_ENV: 'test', MFA_SECRET_KEY: 'ab'.repeat(32) });

const tokens: Record<string, string> = {};
async function request(method: string, path: string, body?: unknown, token?: string) {
  const res = await handleRequest(new NextRequest(`http://localhost:3000/api/${path}`, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { cookie: `invoix_token=${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), path.split('/'));
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null, text };
}
async function login(email: string) {
  const res = await handleRequest(new NextRequest('http://localhost:3000/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'legacy-secret' }) }), ['auth', 'login']);
  return res.headers.get('set-cookie')!.match(/invoix_token=([^;]+)/)![1];
}
// Provider APIs are replaced by a recorder so tests never reach the internet.
const calls: { url: string; init?: RequestInit }[] = [];
let reply: (url: string) => { status: number; body: unknown } = () => ({ status: 404, body: {} });
const realFetch = globalThis.fetch;

before(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const directory = new URL('../db/migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) await pool().query(await readFile(new URL(name, directory), 'utf8'));
  const hash = await bcrypt.hash('legacy-secret', 4);
  await transaction(async db => {
    for (const [name, role] of [['superAdmin', 2], ['ops', 2], ['buyer', 0]] as const) await insert('users', { email: `${name.toLowerCase()}@example.test`, encrypted_password: hash, role, jti: randomUUID() }, db);
  });
  await rows("UPDATE users SET super_admin=true WHERE email='superadmin@example.test'");
  for (const name of ['superAdmin', 'ops', 'buyer']) tokens[name] = await login(`${name.toLowerCase()}@example.test`);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    calls.push({ url: target, init });
    const { status, body } = reply(target);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});
after(async () => {
  globalThis.fetch = realFetch;
  await pool().end();
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
});

test('only operations can view, and only the super administrator can change integration settings', async () => {
  assert.equal((await request('GET', 'portal/integrations', undefined, tokens.buyer)).status, 403);
  const list = await request('GET', 'portal/integrations', undefined, tokens.ops);
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.map((i: any) => i.provider), ['smtp', 'mnotify', 'paystack', 'flutterwave', 'ghipss', 'payment_routing']);
  assert.equal(list.data[0].can_edit, false);
  assert.equal((await request('GET', 'portal/integrations', undefined, tokens.superAdmin)).data[0].can_edit, true);
  assert.equal((await request('PUT', 'portal/integrations/smtp', { enabled: false, config: { host: 'smtp.example.test' } }, tokens.ops)).status, 403);
});

test('credentials are write-only, sealed at rest, kept when left blank, and never appear in the API', async () => {
  const smtp = { host: 'smtp.example.test', port: 587, security: 'starttls', username: 'mailer', from_name: 'INVOX', from_email: 'no-reply@example.test' };
  const saved = await request('PUT', 'portal/integrations/smtp', { enabled: true, config: smtp, secrets: { password: 'smtp-password-9876' } }, tokens.superAdmin);
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.data.secrets.password, { set: true, hint: '••••9876', required: false });
  const [stored] = await rows("SELECT * FROM integration_settings WHERE provider='smtp'");
  assert.ok(stored.secrets_sealed && !stored.secrets_sealed.includes('smtp-password'));
  // Saving again without the password keeps it; the listing never contains it.
  assert.equal((await request('PUT', 'portal/integrations/smtp', { enabled: true, config: { ...smtp, port: 465, security: 'tls' }, secrets: { password: '' } }, tokens.superAdmin)).data.secrets.password.hint, '••••9876');
  const list = await request('GET', 'portal/integrations', undefined, tokens.superAdmin);
  assert.equal(list.text.includes('smtp-password'), false);
  const events = await rows("SELECT details FROM portal_events WHERE event='integration.updated'");
  assert.equal(JSON.stringify(events).includes('smtp-password'), false);
  assert.ok(events.some(e => e.details.credentials_changed.includes('password')));
  // Switching on needs a complete configuration.
  assert.equal((await request('PUT', 'portal/integrations/smtp', { enabled: true, config: { host: 'smtp.example.test' } }, tokens.superAdmin)).status, 422);
  assert.equal((await request('PUT', 'portal/integrations/smtp', { enabled: false, config: { host: 'smtp.example.test' } }, tokens.superAdmin)).status, 200);
});

test('payment keys must match test or live mode, and routing needs a switched-on provider', async () => {
  const paystack = { public_key: 'pk_test_abc123', currency: 'GHS' };
  assert.equal((await request('PUT', 'portal/integrations/paystack', { enabled: true, mode: 'test', config: paystack }, tokens.superAdmin)).status, 422);
  assert.equal((await request('PUT', 'portal/integrations/paystack', { enabled: true, mode: 'live', config: paystack, secrets: { secret_key: 'sk_test_abc' } }, tokens.superAdmin)).status, 422);
  assert.equal((await request('PUT', 'portal/integrations/paystack', { enabled: true, mode: 'test', config: paystack, secrets: { secret_key: 'sk_live_abc' } }, tokens.superAdmin)).status, 422);
  assert.equal((await request('PUT', 'portal/integrations/paystack', { enabled: true, mode: 'test', config: paystack, secrets: { secret_key: 'sk_test_secret1234' } }, tokens.superAdmin)).status, 200);
  const flutterwave = { public_key: 'FLWPUBK_TEST-abc123-X', currency: 'GHS' };
  assert.equal((await request('PUT', 'portal/integrations/flutterwave', { enabled: true, mode: 'test', config: flutterwave, secrets: { secret_key: 'FLWSECK_TEST-abc-X' } }, tokens.superAdmin)).status, 422, 'encryption key required');
  assert.equal((await request('PUT', 'portal/integrations/flutterwave', { enabled: true, mode: 'test', config: flutterwave, secrets: { secret_key: 'FLWSECK_TEST-abc-X', encryption_key: 'FLWSECK_TESTenc' } }, tokens.superAdmin)).status, 200);
  assert.equal((await request('PUT', 'portal/integrations/ghipss', { enabled: true, config: { partner_name: 'Partner Bank', base_url: 'http://insecure.example', participant_code: 'P1', settlement_bank_code: '300', settlement_account_number: '1234567', settlement_account_name: 'INVOX' }, secrets: { client_secret: 'x' } }, tokens.superAdmin)).status, 422);

  assert.equal((await request('PUT', 'portal/integrations/payment_routing', { enabled: true, config: { collections: 'ghipss', disbursements: 'paystack' } }, tokens.superAdmin)).status, 422);
  assert.equal((await request('PUT', 'portal/integrations/payment_routing', { enabled: true, config: { collections: 'flutterwave', disbursements: 'paystack' } }, tokens.superAdmin)).status, 200);
  // A provider in use cannot be switched off until payments are routed elsewhere.
  assert.equal((await request('PUT', 'portal/integrations/paystack', { enabled: false, mode: 'test', config: paystack }, tokens.superAdmin)).status, 409);
});

test('connection tests call the provider APIs with the stored credentials and record the outcome', async () => {
  reply = target => target.startsWith('https://api.paystack.co/balance') ? { status: 200, body: { status: true, data: [{ currency: 'GHS', balance: 0 }] } } : { status: 401, body: { status: 'error', message: 'Invalid authorization key' } };
  const paystack = await request('POST', 'portal/integrations/paystack/test', {}, tokens.superAdmin);
  assert.deepEqual(paystack.data, { ok: true, message: 'Paystack test key accepted (balances in GHS).' });
  assert.equal((calls.at(-1)!.init!.headers as Record<string, string>).Authorization, 'Bearer sk_test_secret1234');
  const flutterwave = await request('POST', 'portal/integrations/flutterwave/test', {}, tokens.superAdmin);
  assert.equal(flutterwave.data.ok, false);
  assert.match(flutterwave.data.message, /Flutterwave rejected the secret key: Invalid authorization key/);
  const [row] = await rows("SELECT last_test_ok,last_test_message FROM integration_settings WHERE provider='flutterwave'");
  assert.equal(row.last_test_ok, false);
  assert.equal((await request('POST', 'portal/integrations/paystack/test', {}, tokens.ops)).status, 403);
});

test('mNotify: the API key is checked, test SMS is sent, and numbers are normalised for Ghana', async () => {
  assert.equal(smsNumber('024 412 3456'), '233244123456');
  assert.equal(smsNumber('+233 24 412 3456'), '233244123456');
  assert.equal((await request('PUT', 'portal/integrations/mnotify', { enabled: true, config: { sender_id: 'INVOX-GH-TOOLONG' }, secrets: { api_key: 'mn-key-0001' } }, tokens.superAdmin)).status, 422);
  assert.equal((await request('PUT', 'portal/integrations/mnotify', { enabled: true, config: { sender_id: 'INVOX' }, secrets: { api_key: 'mn-key-0001' } }, tokens.superAdmin)).status, 200);
  reply = target => target.includes('/balance/sms') ? { status: 200, body: { status: 'success', balance: 120 } } : target.includes('/sms/quick') ? { status: 200, body: { status: 'success', code: '2000' } } : { status: 404, body: {} };
  const result = await request('POST', 'portal/integrations/mnotify/test', { to: '0244123456' }, tokens.superAdmin);
  assert.equal(result.data.ok, true, result.text);
  const sent = calls.find(call => call.url.includes('/sms/quick'))!;
  assert.match(sent.url, /key=mn-key-0001/);
  const payload = JSON.parse(String(sent.init!.body));
  assert.deepEqual(payload.recipient, ['233244123456']);
  assert.equal(payload.sender, 'INVOX');
  await sendSms(['0201234567'], 'Hello');
  reply = () => ({ status: 200, body: { status: 'error', message: 'Insufficient balance' } });
  await assert.rejects(sendSms(['0201234567'], 'Hello'), /Insufficient balance/);
});

test('saved SMTP settings are used for outgoing mail and failures are reported, not hidden', async () => {
  const smtp = { host: '127.0.0.1', port: 1, security: 'none', username: '', from_name: 'INVOX', from_email: 'no-reply@example.test' };
  assert.equal((await request('PUT', 'portal/integrations/smtp', { enabled: true, config: smtp }, tokens.superAdmin)).status, 200);
  const result = await request('POST', 'portal/integrations/smtp/test', {}, tokens.superAdmin);
  assert.equal(result.data.ok, false);
  assert.match(result.data.message, /Connection failed/);
  // With saved SMTP switched on, password reset mail goes through it (here: unreachable, so the request fails instead of faking success).
  const reset = await request('POST', 'auth/forgot-password', { email: 'buyer@example.test' });
  assert.notEqual(reset.status, 200);
  assert.equal(reset.data?.preview_url, undefined);
});
