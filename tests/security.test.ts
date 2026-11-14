// Regression tests for the 2026-11-12 security audit (findings F01–F24). Each test follows the
// report's acceptance criteria against an isolated schema.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID, createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import { NextRequest } from 'next/server';
// The pool is created lazily on first use, after the environment below selects the isolated schema and a small pool.
import { handleRequest } from '../src/server/http';
import { pool, rows, insert, transaction } from '../src/server/db';
import { POST as uploadDocument } from '../src/app/api/portal/documents/route';

const connection = process.env.TEST_DATABASE_URL;
if (!connection || !new URL(connection).pathname.endsWith('_test')) throw new Error('Set TEST_DATABASE_URL to an isolated PostgreSQL database ending in _test.');
const admin = new Pool({ connectionString: connection });
const schema = `security_test_${process.pid}_${Date.now()}`;
const url = new URL(connection);
url.searchParams.set('options', `-c search_path=${schema}`);
Object.assign(process.env, { DATABASE_URL: url.toString(), APP_URL: 'http://localhost:3000', NODE_ENV: 'test', DATABASE_POOL_MAX: '3', MFA_SECRET_KEY: 'b'.repeat(64) });
delete process.env.SMTP_URL;


const fx: Record<string, any> = {};
const tokens: Record<string, string> = {};
async function request(method: string, path: string, body?: unknown, token?: string, extra: Record<string, string> = {}) {
  const res = await handleRequest(new NextRequest(`http://localhost:3000/api/${path}`, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { cookie: `invoix_token=${token}` } : {}), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), path.split('?')[0].split('/'));
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null, headers: res.headers };
}
const cookie = (res: { headers: Headers }, name: string) => res.headers.get('set-cookie')?.match(new RegExp(`${name}=([^;]+)`))?.[1];
async function login(email: string, password = 'legacy-secret') {
  const res = await request('POST', 'auth/login', { email, password });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return cookie(res, 'invoix_token')!;
}
function totp(secret: Buffer, step = Math.floor(Date.now() / 30000)) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const hash = createHmac('sha1', secret).update(counter).digest(); const offset = hash[19] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
function decodeSecret(text: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const char of text) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  return Buffer.from(bits.match(/.{8}/g)!.map(byte => parseInt(byte, 2)));
}
const draft = (extra: Record<string, unknown> = {}) => ({ invoice: { invoice_number: randomUUID(), currency: 'GHS', issue_date: '2026-01-01', due_date: '2030-12-31', description: 'Goods', payment_terms: 'Net 30', financing_eligible: true, amount: '1000.00', programme_id: fx.programme.id, supplier_id: fx.supplier.id, status: 'draft', ...extra } });

before(async () => {
  process.env.DOCUMENT_STORAGE_PATH = await mkdtemp(join(tmpdir(), 'invox-security-test-'));
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const directory = new URL('../db/migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) await pool().query(await readFile(new URL(name, directory), 'utf8'));
  const hash = await bcrypt.hash('legacy-secret', 4);
  await transaction(async db => {
    fx.buyerA = await insert('buyers', { name: 'Buyer A', registration_number: 'A-1', contact_email: 'a@example.test' }, db);
    fx.buyerB = await insert('buyers', { name: 'Buyer B', registration_number: 'B-1', contact_email: 'b@example.test' }, db);
    for (const [name, role, buyer] of [['ops', 2, null], ['ops2', 2, null], ['adminA', 0, fx.buyerA.id], ['adminA2', 0, fx.buyerA.id], ['adminB', 0, fx.buyerB.id], ['supplierUser', 1, null], ['invited', 3, null], ['uninvited', 3, null]] as const)
      fx[name] = await insert('users', { email: `${name.toLowerCase()}@example.test`, encrypted_password: hash, role, buyer_id: buyer, jti: randomUUID() }, db);
    fx.supplier = await insert('suppliers', { name: 'Supplier A', email: fx.supplierUser.email, user_id: fx.supplierUser.id, tax_id: 'TAX-SECRET-1', risk_rating: 'high' }, db);
    fx.programme = await insert('programmes', { name: 'Programme A', buyer_id: fx.buyerA.id, limit: '100000', fee_percent: '2', maturity_days: 30, currency: 'GHS', agreement_reference: 'PRIVATE-AGREEMENT-MARKER' }, db);
    fx.programme2 = await insert('programmes', { name: 'Programme A2', buyer_id: fx.buyerA.id, limit: '100000', fee_percent: '2', maturity_days: 30, currency: 'GHS' }, db);
    fx.programmeB = await insert('programmes', { name: 'Programme B', buyer_id: fx.buyerB.id, limit: '5000', fee_percent: '2', maturity_days: 30, status: 'active' }, db);
  });
  for (const p of [fx.programme, fx.programme2]) await rows('INSERT INTO portal_programme_suppliers VALUES($1,$2)', [p.id, fx.supplier.id]);
  await rows('INSERT INTO portal_supplier_relationships(buyer_id,supplier_id) VALUES($1,$2)', [fx.buyerA.id, fx.supplier.id]);
  for (const name of ['ops', 'ops2', 'adminA', 'adminA2', 'adminB', 'supplierUser', 'invited', 'uninvited']) tokens[name] = await login(fx[name].email);
});
after(async () => {
  await rm(process.env.DOCUMENT_STORAGE_PATH!, { recursive: true, force: true });
  await pool().end();
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
});

test('F01: unverified self-registration and orphaned buyer accounts never fall back to an unrestricted scope', async () => {
  const signup = await request('POST', 'portal-auth/register', { name: 'Fresh applicant', email: 'fresh@example.test', password: 'Fresh-password-123' });
  assert.equal(signup.status, 201);
  const fresh = cookie(signup, 'invoix_token')!;
  for (const path of ['portal/manage/programmes', 'portal/manage/supplier_relationships', 'programmes', 'suppliers', 'invoices', `programmes/${fx.programmeB.id}`, 'portal/manage/programmes/options/financers'])
    assert.equal((await request('GET', path, undefined, fresh)).status, 403, path);
  const bundle = await request('GET', 'portal/bootstrap', undefined, fresh);
  assert.equal(bundle.status, 200);
  assert.deepEqual([bundle.data.programmes, bundle.data.suppliers, bundle.data.financiers, bundle.data.buyers].map(list => list.length), [0, 0, 0, 0]);

  // A legacy account whose buyer membership was cleared outside the product.
  const orphan = await insert('users', { email: 'orphan@example.test', encrypted_password: await bcrypt.hash('legacy-secret', 4), role: 0, buyer_id: null, jti: randomUUID() });
  const orphanToken = await login(orphan.email);
  assert.equal((await request('GET', 'portal/manage/programmes', undefined, orphanToken)).status, 403);
  for (const action of ['pause', 'archive', 'restore', 'submit'])
    assert.equal((await request('POST', `portal/manage/programmes/${fx.programmeB.id}/${action}`, { reason: 'Cross tenant attempt for audit' }, orphanToken)).status, 403, action);
  assert.equal((await rows('SELECT status FROM programmes WHERE id=$1', [fx.programmeB.id]))[0].status, 'active');

  // Removing a membership through the product disables the account and ends its sessions.
  const removed = await request('PATCH', `buyers/${fx.buyerA.id}`, { buyer: { users_attributes: [{ id: fx.adminA2.id, _destroy: true }] } }, tokens.adminA);
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.ok((await rows('SELECT disabled_at FROM users WHERE id=$1', [fx.adminA2.id]))[0].disabled_at);
  assert.equal((await request('GET', 'portal/session', undefined, tokens.adminA2)).status, 401);
  assert.equal((await request('POST', 'auth/login', { email: fx.adminA2.email, password: 'legacy-secret' })).status, 401);
});

test('F04/F02: status is server-controlled and financiers see tenders only by invitation', async () => {
  assert.equal((await request('POST', 'invoices', draft({ status: 'approved' }), tokens.adminA)).status, 409);
  assert.equal((await request('POST', `buyers/${fx.buyerA.id}/invoices`, draft({ status: 'tender' }), tokens.adminA)).status, 409);
  const foreignUser = await insert('users', { email: 'unrelated@example.test', encrypted_password: '', role: 1, jti: randomUUID() });
  const foreignSupplier = await insert('suppliers', { name: 'Unrelated supplier', email: foreignUser.email, user_id: foreignUser.id });
  assert.equal((await request('POST', 'invoices', draft({ supplier_id: foreignSupplier.id }), tokens.adminA)).status, 422);
  const created = await request('POST', 'invoices', draft(), tokens.adminA);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  fx.invoice = created.data;
  for (const path of [`invoices/${fx.invoice.id}`, `buyers/${fx.buyerA.id}/invoices/${fx.invoice.id}`, `v1/invoices/${fx.invoice.id}`])
    for (const status of ['approved', 'tender']) assert.equal((await request('PATCH', path, { invoice: { status } }, tokens.adminA)).status, 409, `${path} ${status}`);
  // Even a tender-status invoice without a published tender and invitation cannot be financed.
  await rows("UPDATE invoices SET status='tender',invoice_approval_status='approved' WHERE id=$1", [fx.invoice.id]);
  const bid = { bid: { amount: '900', currency: 'GHS', discount_type: 'fixed', discount_fee: '0', other_fees: '0', day_count_basis: '365', expiry_date: '2030-12-01' } };
  assert.equal((await request('POST', `invoices/${fx.invoice.id}/bids`, bid, tokens.invited)).status, 403);
  const [tender] = await rows("INSERT INTO financing_tenders(invoice_id,programme_id,tender_reference,currency,financing_amount_requested,opens_at,closes_at,maturity_date,eligible_conditions,risk_disclosures,published_by,published_at,status,created_by) VALUES($1,$2,'TND-SEC','GHS','1000',now(),now()+interval '10 days','2030-12-31','Invited only','Disclosure',$3,now(),'open',$3) RETURNING id", [fx.invoice.id, fx.programme.id, fx.ops.id]);
  await rows('INSERT INTO portal_tender_invitations VALUES($1,$2)', [tender.id, fx.invited.id]);
  for (const [name, visible] of [['invited', true], ['uninvited', false]] as const) {
    const opportunities = await request('GET', `financers/${fx[name].id}/opportunities`, undefined, tokens[name]);
    assert.equal(opportunities.data.some((i: any) => String(i.id) === String(fx.invoice.id)), visible, name);
    const list = await request('GET', 'invoices', undefined, tokens[name]);
    assert.equal(list.data.some((i: any) => String(i.id) === String(fx.invoice.id)), visible, name);
    assert.equal((await request('GET', `invoices/${fx.invoice.id}`, undefined, tokens[name])).status, visible ? 200 : 403, name);
    const bundle = await request('GET', 'portal/bootstrap', undefined, tokens[name]);
    assert.equal(bundle.data.invoices.some((i: any) => String(i.id) === String(fx.invoice.id)), visible, name);
  }
  assert.equal((await request('POST', `invoices/${fx.invoice.id}/bids`, bid, tokens.uninvited)).status, 403);
  assert.equal((await request('POST', `invoices/${fx.invoice.id}/bids`, bid, tokens.invited)).status, 201);
});

test('F03/F09: directories and bootstraps carry only the fields each counterparty needs', async () => {
  const foreign = await request('GET', 'suppliers', undefined, tokens.adminB);
  assert.equal(foreign.status, 200);
  assert.ok(!foreign.data.some((s: any) => String(s.id) === String(fx.supplier.id)));
  assert.equal((await request('GET', `suppliers/${fx.supplier.id}`, undefined, tokens.adminB)).status, 404);
  const related = await request('GET', 'suppliers', undefined, tokens.adminA);
  const profile = related.data.find((s: any) => String(s.id) === String(fx.supplier.id));
  assert.ok(profile);
  for (const key of ['tax_id', 'risk_rating', 'screening_status', 'registered_address', 'vat_number']) assert.equal(key in profile, false, key);
  const financier = await request('GET', 'portal/bootstrap', undefined, tokens.invited);
  const text = JSON.stringify(financier.data);
  for (const marker of ['PRIVATE-AGREEMENT-MARKER', 'TAX-SECRET-1', 'fee_percent']) assert.equal(text.includes(marker), false, marker);
  assert.equal((await request('GET', 'portal/bootstrap', undefined, tokens.ops)).data.programmes.some((p: any) => p.agreement_reference === 'PRIVATE-AGREEMENT-MARKER'), true);
});

test('F05/F06: MFA challenges die with the credential epoch, and a code is accepted once', async () => {
  const setup = await request('POST', 'portal-auth/mfa-setup', { password: 'legacy-secret' }, tokens.ops2);
  assert.equal(setup.status, 200);
  const secret = decodeSecret(setup.data.secret);
  const now = Math.floor(Date.now() / 30000);
  assert.equal((await request('POST', 'portal-auth/mfa-enrol', { code: totp(secret, now - 1) }, tokens.ops2)).status, 200);
  const challenge = async () => cookie(await request('POST', 'auth/login', { email: fx.ops2.email, password: 'legacy-secret' }), 'invox_mfa_challenge')!;
  const verify = (token: string, code: string) => request('POST', 'portal-auth/mfa-verify', { code }, undefined, { cookie: `invox_mfa_challenge=${token}` });
  // Two simultaneous challenges, one code: exactly one session is issued.
  const [first, second] = [await challenge(), await challenge()];
  const code = totp(secret, now);
  const results = await Promise.all([verify(first, code), verify(second, code)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 422]);
  // A challenge issued before a password change cannot be completed afterwards, even with a fresh code.
  const stale = await challenge();
  const fresh = cookie(results.find(r => r.status === 200)!, 'invoix_token')!;
  const changed = await request('POST', 'auth/change-password', { current_password: 'legacy-secret', password: 'rotated-password-123', password_confirmation: 'rotated-password-123' }, fresh);
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  const late = await verify(stale, totp(secret, now + 1));
  assert.equal(late.status, 422);
  assert.equal(cookie(late, 'invoix_token'), undefined);
});

test('F07: concurrent demotions cannot remove every operations administrator', async () => {
  const opsA = await insert('users', { email: 'race-a@example.test', encrypted_password: await bcrypt.hash('legacy-secret', 4), role: 2, jti: randomUUID() });
  const opsB = await insert('users', { email: 'race-b@example.test', encrypted_password: await bcrypt.hash('legacy-secret', 4), role: 2, jti: randomUUID() });
  // Only the two racers remain active; disabled operators are not counted as recovery access.
  await rows("UPDATE users SET disabled_at=now() WHERE role=2 AND id NOT IN ($1,$2)", [opsA.id, opsB.id]);
  const [a, b] = [await login(opsA.email), await login(opsB.email)];
  const results = await Promise.all([request('PATCH', `users/${opsB.id}`, { user: { role: 'buyer_admin', buyer_id: fx.buyerA.id } }, a), request('PATCH', `users/${opsA.id}`, { user: { role: 'buyer_admin', buyer_id: fx.buyerA.id } }, b)]);
  assert.ok(results.some(r => r.status === 409), JSON.stringify(results.map(r => r.status)));
  assert.ok((await rows('SELECT id FROM users WHERE role=2 AND disabled_at IS NULL')).length >= 1);
  await rows("UPDATE users SET disabled_at=NULL WHERE role=2");
});

test('F08: nested module reads share one connection and do not starve a small pool', async () => {
  const results = await Promise.all(Array.from({ length: 20 }, (_, n) => request('GET', `portal/manage/${['buyers', 'suppliers', 'invoices', 'documents'][n % 4]}`, undefined, tokens.ops)));
  assert.deepEqual([...new Set(results.map(r => r.status))], [200]);
  // A failing nested write rolls back with its outer transaction.
  await assert.rejects(transaction(async () => { await transaction(async db => rows("UPDATE buyers SET name='rolled back' WHERE id=$1", [fx.buyerB.id], db)); throw new Error('outer failure'); }));
  assert.equal((await rows('SELECT name FROM buyers WHERE id=$1', [fx.buyerB.id]))[0].name, 'Buyer B');
});

test('F12/F21: bodies are bounded while streaming and every API response carries browser protections', async () => {
  const huge = new ReadableStream({ start(controller) { for (let i = 0; i < 20; i++) controller.enqueue(new Uint8Array(100 * 1024).fill(32)); controller.close(); } });
  const res = await handleRequest(new NextRequest('http://localhost:3000/api/portal/profile', { method: 'PATCH', headers: { cookie: `invoix_token=${tokens.adminA}`, 'Content-Type': 'application/json' }, body: huge, duplex: 'half' } as any), ['portal', 'profile']);
  assert.equal(res.status, 413);
  for (const header of ['x-frame-options', 'content-security-policy', 'referrer-policy', 'x-content-type-options']) assert.ok(res.headers.get(header), header);
  const form = new FormData(); form.set('file', new File([new Uint8Array(11 * 1024 * 1024)], 'big.pdf', { type: 'application/pdf' }));
  const upload = await uploadDocument(new NextRequest('http://localhost:3000/api/portal/documents', { method: 'POST', headers: { cookie: `invoix_token=${tokens.adminA}` }, body: form }));
  assert.equal(upload.status, 413);
  assert.equal((await rows('SELECT count(*)::int AS n FROM documents')).at(0)!.n, 0);
});

test('F18: one economic claim per buyer, supplier and normalised reference across programmes', async () => {
  const reference = `INV-${randomUUID().slice(0, 6)}`;
  assert.equal((await request('POST', 'invoices', draft({ invoice_number: reference }), tokens.adminA)).status, 201);
  assert.equal((await request('POST', 'invoices', draft({ invoice_number: ` ${reference.toLowerCase()} ` }), tokens.adminA)).status, 409);
  assert.equal((await request('POST', 'invoices', draft({ invoice_number: reference, programme_id: fx.programme2.id }), tokens.adminA)).status, 409);
  const concurrent = await Promise.all([1, 2].map(() => request('POST', 'invoices', draft({ invoice_number: `${reference}-RACE` }), tokens.adminA)));
  assert.deepEqual(concurrent.map(r => r.status).sort(), [201, 409]);
});

test('F19: a failed audit write rolls back the business mutation', async () => {
  await admin.query(`CREATE FUNCTION "${schema}".fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event='profile.updated' THEN RAISE EXCEPTION 'audit sink unavailable'; END IF; RETURN NEW; END $$`);
  await admin.query(`CREATE TRIGGER fail_audit BEFORE INSERT ON "${schema}".portal_events FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_audit()`);
  try {
    assert.equal((await request('PATCH', 'portal/profile', { name: 'Should not persist' }, tokens.adminA)).status, 500);
    assert.notEqual((await rows('SELECT name FROM users WHERE id=$1', [fx.adminA.id]))[0].name, 'Should not persist');
  } finally { await admin.query(`DROP TRIGGER fail_audit ON "${schema}".portal_events`); }
});

test('F20: a stale edit is rejected instead of silently overwriting', async () => {
  const created = await request('POST', 'portal/manage/invoices', { programme_id: fx.programme.id, supplier_id: fx.supplier.id, invoice_number: randomUUID() }, tokens.adminA);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const version = created.data.updated_at;
  const first = await request('PATCH', `portal/manage/invoices/${created.data.id}`, { description: 'First editor' }, tokens.adminA, { 'x-expected-updated-at': version });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const stale = await request('PATCH', `portal/manage/invoices/${created.data.id}`, { description: 'Second editor' }, tokens.adminA, { 'x-expected-updated-at': version });
  assert.equal(stale.status, 409);
  assert.equal((await rows('SELECT description FROM invoices WHERE id=$1', [created.data.id]))[0].description, 'First editor');
});

test('F24: operations sessions are enrolment-only until an authenticator is verified', async () => {
  process.env.REQUIRE_OPERATIONS_MFA = 'true';
  try {
    assert.equal((await request('GET', 'portal/manage/users', undefined, tokens.ops)).status, 403);
    assert.equal((await request('GET', 'portal/session', undefined, tokens.ops)).data.mfa_enrolment_required, true);
    const setup = await request('POST', 'portal-auth/mfa-setup', { password: 'legacy-secret' }, tokens.ops);
    assert.equal(setup.status, 200);
    assert.equal((await request('POST', 'portal-auth/mfa-enrol', { code: totp(decodeSecret(setup.data.secret)) }, tokens.ops)).status, 200);
    assert.equal((await request('GET', 'portal/manage/users', undefined, tokens.ops)).status, 200);
  } finally { delete process.env.REQUIRE_OPERATIONS_MFA; }
});

test('a trusted browser skips the authenticator code until trust is forgotten or the password changes', async () => {
  const user = await insert('users', { email: 'trusted@example.test', name: 'Trusted', encrypted_password: await bcrypt.hash('legacy-secret', 4), role: 2, jti: randomUUID() });
  const signIn = (password = 'legacy-secret', device?: string) => request('POST', 'auth/login', { email: user.email, password }, undefined, device ? { cookie: `invox_trusted_device=${device}` } : {});
  const setup = await request('POST', 'portal-auth/mfa-setup', { password: 'legacy-secret' }, await login(user.email));
  const secret = decodeSecret(setup.data.secret);
  const now = Math.floor(Date.now() / 30000);
  assert.equal((await request('POST', 'portal-auth/mfa-enrol', { code: totp(secret, now - 1) }, cookie(await signIn(), 'invoix_token'))).status, 200);
  const trustWith = async (step: number, password = 'legacy-secret') => {
    const challenge = cookie(await signIn(password), 'invox_mfa_challenge')!;
    const verified = await request('POST', 'portal-auth/mfa-verify', { code: totp(secret, step), trust_device: true }, undefined, { cookie: `invox_mfa_challenge=${challenge}` });
    assert.equal(verified.status, 200, JSON.stringify(verified.data));
    assert.equal(verified.data.trusted, true);
    return { device: cookie(verified, 'invox_trusted_device')!, session: cookie(verified, 'invoix_token')! };
  };
  const { device, session } = await trustWith(now);
  assert.match(device, /^[a-f0-9]{64}$/);
  assert.equal((await rows('SELECT token_hash FROM trusted_devices WHERE user_id=$1', [user.id]))[0].token_hash === device, false, 'only a hash is stored');
  // Trusted browser: password only, and the session counts as verified. Other browsers still need the code.
  const skipped = await signIn('legacy-secret', device);
  assert.equal(skipped.status, 200);
  assert.equal(skipped.data.mfa_required, undefined);
  const [stored] = await rows('SELECT mfa_verified_at FROM app_sessions WHERE token_hash=encode(sha256($1::bytea),\'hex\')', [cookie(skipped, 'invoix_token')]);
  assert.ok(stored.mfa_verified_at);
  assert.equal((await signIn()).data.mfa_required, true);
  assert.equal((await signIn('wrong-password-1', device)).status, 401);
  assert.equal((await request('GET', 'portal-auth/trusted-devices', undefined, session)).data.count, 1);
  // Forgetting trusted browsers brings the code back.
  assert.equal((await request('DELETE', 'portal-auth/trusted-devices', undefined, session)).status, 200);
  assert.equal((await signIn('legacy-secret', device)).data.mfa_required, true);
  // A password change ends trust as well.
  const again = await trustWith(now + 1);
  assert.equal((await signIn('legacy-secret', again.device)).data.mfa_required, undefined);
  const changed = await request('POST', 'auth/change-password', { current_password: 'legacy-secret', password: 'rotated-password-456', password_confirmation: 'rotated-password-456' }, again.session);
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.equal((await signIn('rotated-password-456', again.device)).data.mfa_required, true);
});
