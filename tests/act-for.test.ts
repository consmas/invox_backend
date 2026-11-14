// Super administrator acting on behalf of organisations: only the super administrator may do it, the work runs
// under the organisation's own rules, every change is logged and notified, and two-person rules follow the person.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import { NextRequest } from 'next/server';
import { handleRequest } from '../src/server/http';
import { pool, rows, insert, transaction } from '../src/server/db';
import { POST as uploadDocument } from '../src/app/api/portal/documents/route';
import { preparedOnBehalfBy } from '../src/server/act-for';
import { validateFieldReferences } from '../src/server/fields';

const connection = process.env.TEST_DATABASE_URL;
if (!connection || !new URL(connection).pathname.endsWith('_test')) throw new Error('Set TEST_DATABASE_URL to an isolated PostgreSQL database ending in _test.');
const admin = new Pool({ connectionString: connection });
const schema = `act_for_test_${process.pid}_${Date.now()}`;
const url = new URL(connection);
url.searchParams.set('options', `-c search_path=${schema}`);
Object.assign(process.env, { DATABASE_URL: url.toString(), APP_URL: 'http://localhost:3000', NODE_ENV: 'test' });

const fx: Record<string, any> = {};
const tokens: Record<string, string> = {};
const cookieFor = (token: string, acting?: string) => `invoix_token=${token}${acting ? `; invox_act_for=${acting}` : ''}`;
async function request(method: string, path: string, body?: unknown, token?: string, acting?: string) {
  const res = await handleRequest(new NextRequest(`http://localhost:3000/api/${path}`, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { cookie: cookieFor(token, acting) } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), path.split('?')[0].split('/'));
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null, headers: res.headers };
}
async function login(email: string) {
  const res = await handleRequest(new NextRequest('http://localhost:3000/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'legacy-secret' }) }), ['auth', 'login']);
  return res.headers.get('set-cookie')!.match(/invoix_token=([^;]+)/)![1];
}
async function startActing(target: string, reason = 'Customer asked us to load records by phone', token = tokens.superAdmin) {
  const res = await request('POST', 'portal/act-for', { target, reason }, token);
  const cookie = res.headers.get('set-cookie')?.match(/invox_act_for=([^;]+)/)?.[1];
  return { ...res, cookie };
}
async function upload(token: string, acting?: string, category = 'incorporation') {
  const form = new FormData(); form.set('file', new File([`%PDF-1.4 ${randomUUID()}`], 'evidence.pdf', { type: 'application/pdf' })); form.set('category', category);
  const res = await uploadDocument(new NextRequest('http://localhost:3000/api/portal/documents', { method: 'POST', headers: { cookie: cookieFor(token, acting) }, body: form }));
  return { status: res.status, data: await res.json() };
}

before(async () => {
  process.env.DOCUMENT_STORAGE_PATH = await mkdtemp(join(tmpdir(), 'invox-act-for-'));
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const directory = new URL('../db/migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) await pool().query(await readFile(new URL(name, directory), 'utf8'));
  const hash = await bcrypt.hash('legacy-secret', 4);
  await transaction(async db => {
    fx.buyer = await insert('buyers', { name: 'Acme Buyer', registration_number: 'B-1', contact_email: 'b@example.test' }, db);
    for (const [name, role, buyer] of [['superAdmin', 2, null], ['checker', 2, null], ['buyerAdmin', 0, fx.buyer.id], ['buyerColleague', 0, fx.buyer.id], ['supplierUser', 1, null], ['financer', 3, null]] as const)
      fx[name] = await insert('users', { email: `${name.toLowerCase()}@example.test`, name, encrypted_password: hash, role, buyer_id: buyer, jti: randomUUID() }, db);
    fx.supplier = await insert('suppliers', { name: 'Supplier', email: fx.supplierUser.email, user_id: fx.supplierUser.id }, db);
  });
  await rows('UPDATE users SET super_admin=true WHERE id=$1', [fx.superAdmin.id]);
  await rows("INSERT INTO financier_profiles(user_id,name,country,institution_type) VALUES($1,'Lender','GH','bank')", [fx.financer.id]);
  await rows("INSERT INTO portal_supplier_relationships(buyer_id,supplier_id,contact_email) VALUES($1,$2,'ar@example.test')", [fx.buyer.id, fx.supplier.id]);
  for (const name of ['superAdmin', 'checker', 'buyerAdmin', 'supplierUser']) tokens[name] = await login(fx[name].email);
});
after(async () => {
  await pool().end();
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
  await rm(process.env.DOCUMENT_STORAGE_PATH!, { recursive: true, force: true });
});

test('only the super administrator can act for an organisation, and only with a reason', async () => {
  assert.equal((await startActing(`buyer-${fx.buyer.id}`, 'Loading records', tokens.checker)).status, 403);
  assert.equal((await startActing(`buyer-${fx.buyer.id}`, 'Loading records for them', tokens.buyerAdmin)).status, 403);
  assert.equal((await startActing(`buyer-${fx.buyer.id}`, 'short')).status, 422);
  assert.equal((await startActing('buyer-999999')).status, 404);
  // A forged act-for cookie from another account is ignored: the operator keeps their own scope.
  const forged = Buffer.from(JSON.stringify({ t: `buyer-${fx.buyer.id}`, r: 'Forged delegation attempt', a: fx.checker.id })).toString('base64url');
  assert.equal((await request('GET', 'portal/session', undefined, tokens.checker, forged)).status, 403);
  const ignored = Buffer.from(JSON.stringify({ t: `buyer-${fx.buyer.id}`, r: 'Forged delegation attempt', a: fx.superAdmin.id })).toString('base64url');
  assert.equal((await request('GET', 'portal/session', undefined, tokens.checker, ignored)).data.actor.role, 'platform_ops');
  const session = await request('GET', 'portal/session', undefined, tokens.superAdmin);
  assert.equal(session.data.super_admin, true);
  assert.equal((await request('GET', 'portal/session', undefined, tokens.checker)).data.super_admin, false);
});

test('acting for a buyer runs under the buyer scope, logs every change and notifies every buyer user', async () => {
  const started = await startActing(`buyer-${fx.buyer.id}`);
  assert.equal(started.status, 201, JSON.stringify(started.data));
  assert.equal(started.data.home, '/buyer');
  assert.ok(started.cookie);
  for (const user of [fx.buyerAdmin, fx.buyerColleague]) {
    const [notice] = await rows("SELECT * FROM notifications WHERE user_id=$1 AND event_type='admin_on_behalf' ORDER BY id DESC", [user.id]);
    assert.match(notice.body, /started working on behalf of Acme Buyer/);
  }
  const session = await request('GET', 'portal/session', undefined, tokens.superAdmin, started.cookie);
  assert.equal(session.data.actor.role, 'buyer_admin');
  assert.equal(session.data.org_ref, `buyer-${fx.buyer.id}`);
  assert.equal(session.data.acting.name, 'Acme Buyer');
  assert.equal(session.data.super_admin, false);
  assert.equal((await request('GET', 'auth/me', undefined, tokens.superAdmin, started.cookie)).data.user.role, 'buyer_admin');
  // Operations-only actions are unavailable while acting as the organisation.
  assert.equal((await request('POST', `portal/verification/buyer-${fx.buyer.id}`, { status: 'APPROVED' }, tokens.superAdmin, started.cookie)).status, 403);
  // Personal account settings stay with the organisation's users.
  assert.equal((await request('PATCH', 'portal/profile', { name: 'Changed by admin' }, tokens.superAdmin, started.cookie)).status, 403);

  const programme = await request('POST', 'portal/programmes', { name: 'Admin-entered programme', currency: 'GHS', limit: '50000', max_tenor_days: 90, supplier_ids: [fx.supplier.id], financier_ids: [fx.financer.id] }, tokens.superAdmin, started.cookie);
  assert.equal(programme.status, 201, JSON.stringify(programme.data));
  assert.equal(String(programme.data.buyer_id), String(fx.buyer.id));
  const [event] = await rows("SELECT * FROM portal_events WHERE event='programme.created' ORDER BY id DESC LIMIT 1");
  assert.equal(String(event.actor_id), String(fx.buyerAdmin.id));
  assert.equal(String(event.acting_admin_id), String(fx.superAdmin.id));
  const [log] = await rows("SELECT * FROM organisation_admin_events WHERE operation='POST portal/programmes'");
  assert.equal(log.org_ref, `buyer-${fx.buyer.id}`);
  assert.equal(String(log.actor_id), String(fx.superAdmin.id));
  assert.equal(log.reason, 'Customer asked us to load records by phone');
  for (const user of [fx.buyerAdmin, fx.buyerColleague]) {
    const [notice] = await rows("SELECT * FROM notifications WHERE user_id=$1 AND event_type='admin_on_behalf' ORDER BY id DESC", [user.id]);
    assert.match(notice.body, /acted on behalf of Acme Buyer: Created programme/);
  }
  await assert.rejects(rows('DELETE FROM organisation_admin_events'), /append-only|immutable|not permitted|refuse/i);

  // A failed action is neither logged nor notified.
  const before = (await rows('SELECT count(*)::int AS n FROM organisation_admin_events'))[0].n;
  assert.equal((await request('POST', 'portal/programmes', { name: 'x' }, tokens.superAdmin, started.cookie)).status, 422);
  assert.equal((await rows('SELECT count(*)::int AS n FROM organisation_admin_events'))[0].n, before);

  // Uploading for the organisation: the administrator remains the uploader and the organisation can use the file.
  const doc = await upload(tokens.superAdmin, started.cookie, 'supporting_document');
  assert.equal(doc.status, 201, JSON.stringify(doc.data));
  const [stored] = await rows('SELECT uploaded_by,on_behalf_of_user_id,org_ref,buyer_id FROM documents WHERE id=$1', [doc.data.id]);
  assert.equal(String(stored.uploaded_by), String(fx.superAdmin.id));
  assert.equal(String(stored.on_behalf_of_user_id), String(fx.buyerAdmin.id));
  assert.equal(stored.org_ref, `buyer-${fx.buyer.id}`);
  const own = await request('GET', 'portal/bootstrap', undefined, tokens.buyerAdmin);
  assert.ok(own.data.documents.some((d: any) => String(d.id) === String(doc.data.id)));
  assert.ok(own.data.adminActions.some((a: any) => a.label === 'Uploaded a document' && a.admin_name === 'superAdmin'));
  assert.equal(own.data.adminActions.some((a: any) => 'admin_email' in a && a.admin_email), false);
  // The same administrator cannot verify evidence they uploaded for the organisation; another operator can.
  assert.equal((await request('POST', `portal/document-reviews/${doc.data.id}`, { decision: 'verify' }, tokens.superAdmin)).status, 403);
  assert.equal((await request('POST', `portal/document-reviews/${doc.data.id}`, { decision: 'verify' }, tokens.checker)).status, 200);

  const stopped = await request('POST', 'portal/act-for/stop', {}, tokens.superAdmin, started.cookie);
  assert.equal(stopped.status, 200);
  assert.match(stopped.headers.get('set-cookie') ?? '', /invox_act_for=;/);
  const ops = await request('GET', 'portal/bootstrap', undefined, tokens.superAdmin);
  assert.ok(ops.data.adminActions.some((a: any) => a.operation === 'act_for.stopped'));
  assert.ok(ops.data.events.some((e: any) => e.on_behalf && e.acting_admin_name === 'superAdmin'));
});

test('the super administrator completes onboarding for a registrant; a different operator must approve it', async () => {
  const signup = await request('POST', 'portal-auth/register', { name: 'Registrant', email: 'registrant@example.test', password: 'Portal-password-123' });
  assert.equal(signup.status, 201);
  const registrant = (await rows("SELECT id FROM users WHERE email='registrant@example.test'"))[0];
  const listed = await request('GET', 'portal/bootstrap', undefined, tokens.superAdmin);
  assert.ok(listed.data.registrations.some((r: any) => String(r.id) === String(registrant.id)));
  assert.deepEqual((await request('GET', 'portal/bootstrap', undefined, tokens.checker)).data.registrations, []);

  const started = await startActing(`user-${registrant.id}`, 'Company sent signed KYC pack by email');
  assert.equal(started.status, 201, JSON.stringify(started.data));
  assert.equal(started.data.home, '/onboarding');
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) { const doc = await upload(tokens.superAdmin, started.cookie); assert.equal(doc.status, 201, JSON.stringify(doc.data)); ids.push(String(doc.data.id)); }
  // Email verification is the registrant's own step; the administrator's documented reason stands in for it.
  const application = { type: 'SUPPLIER', company: { name: 'Registrant Supplies', registrationNumber: 'REG-77', country: 'Ghana', address: '1 Harbour Road, Tema', email: 'registrant@example.test', phone: '+233200000077', industry: 'Logistics' },
    representative: { fullName: 'Registrant', jobTitle: 'Director', email: 'registrant@example.test', phone: '+233200000077', authorised: true }, document_ids: ids, confirmed: true };
  const submitted = await request('POST', 'portal-auth/onboarding', application, tokens.superAdmin, started.cookie);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
  const ref = submitted.data.org_ref;
  assert.match(ref, /^supplier-/);
  // The open session keeps working after the organisation is created.
  assert.equal((await request('GET', 'portal/session', undefined, tokens.superAdmin, started.cookie)).status, 200);
  const [notice] = await rows("SELECT body FROM notifications WHERE user_id=$1 AND event_type='admin_on_behalf' ORDER BY id DESC", [registrant.id]);
  assert.match(notice.body, /Submitted the organisation’s verification \(KYC\) details/);
  await request('POST', 'portal/act-for/stop', {}, tokens.superAdmin, started.cookie);

  for (const id of ids) assert.equal((await request('POST', `portal/document-reviews/${id}`, { decision: 'verify' }, tokens.checker)).status, 200);
  assert.equal((await request('POST', `portal/verification/${ref}`, { status: 'APPROVED' }, tokens.superAdmin)).status, 403);
  const approved = await request('POST', `portal/verification/${ref}`, { status: 'APPROVED' }, tokens.checker);
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
});

test('acting for a financier uses the financier’s own account, and the recorder rule follows the administrator', async () => {
  const started = await startActing(`financier-${fx.financer.id}`);
  assert.equal(started.status, 201, JSON.stringify(started.data));
  const session = await request('GET', 'portal/session', undefined, tokens.superAdmin, started.cookie);
  assert.equal(session.data.actor.role, 'financer');
  assert.equal(session.data.actor.id, String(fx.financer.id));
  // The organisation sees what was done in its name, without the administrator's email address.
  const own = await request('GET', 'portal/bootstrap', undefined, tokens.superAdmin, started.cookie);
  assert.ok(own.data.adminActions.length >= 1);
  assert.ok(own.data.adminActions.every((a: any) => a.org_ref === `financier-${fx.financer.id}`));
  await request('POST', 'portal/act-for/stop', {}, tokens.superAdmin, started.cookie);
  // Evidence recorded while acting is attributed to the administrator, so they cannot confirm it themselves.
  const [programme] = await rows("INSERT INTO programmes(buyer_id,name,\"limit\",fee_percent,maturity_days,currency,status,created_at,updated_at) VALUES($1,'Audit programme',1000,0,30,'GHS','active',now(),now()) RETURNING id", [fx.buyer.id]);
  const [invoice] = await rows("INSERT INTO invoices(programme_id,supplier_id,invoice_number,amount,currency,issue_date,due_date,status,created_at,updated_at) VALUES($1,$2,'AUD-1',100,'GHS',current_date,current_date+30,'draft',now(),now()) RETURNING id", [programme.id, fx.supplier.id]);
  await rows("INSERT INTO audit_events(actor_id,invoice_id,event,record_type,record_id,details,acting_admin_id) VALUES($1,$2,'funding.evidence_recorded','funding',424242,'{}',$3)", [fx.financer.id, invoice.id, fx.superAdmin.id]);
  assert.equal(await preparedOnBehalfBy(String(fx.superAdmin.id), 'funding', '424242'), true);
  assert.equal(await preparedOnBehalfBy(String(fx.checker.id), 'funding', '424242'), false);
});

test('the super administrator onboards a brand-new organisation end to end; its representative then signs in', async () => {
  const input = { name: 'Kojo Mensah', email: 'kojo@newco.example', reason: 'Signed KYC pack received at branch, ref KYC-9001' };
  assert.equal((await request('POST', 'portal/act-for/new-organisation', input, tokens.checker)).status, 403);
  assert.equal((await request('POST', 'portal/act-for/new-organisation', { ...input, email: fx.buyerAdmin.email }, tokens.superAdmin)).status, 409);
  const created = await request('POST', 'portal/act-for/new-organisation', input, tokens.superAdmin);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.home, '/onboarding');
  assert.equal(created.data.setup.sent, true);
  const cookie = created.headers.get('set-cookie')!.match(/invox_act_for=([^;]+)/)![1];
  const [account] = await rows("SELECT id,encrypted_password,portal_registration FROM users WHERE email='kojo@newco.example'");
  assert.equal(account.portal_registration, true);
  assert.equal(account.encrypted_password, '!invitation-pending');
  assert.equal((await request('GET', 'portal/session', undefined, tokens.superAdmin, cookie)).data.needs_onboarding, true);

  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push(String((await upload(tokens.superAdmin, cookie)).data.id));
  const application = { type: 'BUYER', company: { name: 'NewCo Manufacturing', registrationNumber: 'NC-1', country: 'Ghana', address: '5 Spintex Road, Accra', email: 'kojo@newco.example', phone: '+233200009001', industry: 'Manufacturing' },
    representative: { fullName: 'Kojo Mensah', jobTitle: 'Finance Director', email: 'kojo@newco.example', phone: '+233200009001', authorised: true }, document_ids: ids, confirmed: true };
  const submitted = await request('POST', 'portal-auth/onboarding', application, tokens.superAdmin, cookie);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
  await request('POST', 'portal/act-for/stop', {}, tokens.superAdmin, cookie);
  const log = await rows("SELECT operation FROM organisation_admin_events WHERE org_ref=$1 ORDER BY id", [`user-${account.id}`]);
  assert.deepEqual(log.map(e => e.operation).slice(0, 2), ['organisation.registered', 'act_for.started']);

  for (const id of ids) assert.equal((await request('POST', `portal/document-reviews/${id}`, { decision: 'verify' }, tokens.checker)).status, 200);
  assert.equal((await request('POST', `portal/verification/${submitted.data.org_ref}`, { status: 'APPROVED' }, tokens.superAdmin)).status, 403);
  assert.equal((await request('POST', `portal/verification/${submitted.data.org_ref}`, { status: 'APPROVED' }, tokens.checker)).status, 200);

  // The representative chooses a password from the set-up link and lands in their approved buyer workspace.
  const token = new URL(created.data.setup.preview_url).searchParams.get('token');
  const reset = await request('POST', 'auth/reset-password', { token, password: 'Newco-password-123', password_confirmation: 'Newco-password-123' });
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  const signIn = await handleRequest(new NextRequest('http://localhost:3000/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'kojo@newco.example', password: 'Newco-password-123' }) }), ['auth', 'login']);
  assert.equal(signIn.status, 200);
  const own = signIn.headers.get('set-cookie')!.match(/invoix_token=([^;]+)/)![1];
  const session = await request('GET', 'portal/session', undefined, own);
  assert.equal(session.data.actor.role, 'buyer_admin');
  assert.equal(session.data.needs_onboarding, false);
});

test('acting for a supplier names the supplier organisation, not its representative', async () => {
  const started = await startActing(`supplier-${fx.supplier.id}`);
  assert.equal(started.status, 201, JSON.stringify(started.data));
  assert.equal(started.data.name, 'Supplier');
  const session = await request('GET', 'portal/session', undefined, tokens.superAdmin, started.cookie);
  assert.equal(session.data.acting.name, 'Supplier');
});

test('an act-for session that is no longer valid ends instead of locking the administrator out', async () => {
  const started = await startActing(`supplier-${fx.supplier.id}`);
  await rows('UPDATE suppliers SET archived_at=now() WHERE id=$1', [fx.supplier.id]);
  try {
    const blocked = await request('GET', 'portal/session', undefined, tokens.superAdmin, started.cookie);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.acting_ended, true);
    assert.match(blocked.headers.get('set-cookie') ?? '', /invox_act_for=;/);
    // Account actions keep working and drop the stale session.
    const me = await request('GET', 'auth/me', undefined, tokens.superAdmin, started.cookie);
    assert.equal(me.status, 200);
    assert.equal(me.data.user.role, 'platform_ops');
    assert.match(me.headers.get('set-cookie') ?? '', /invox_act_for=;/);
  } finally { await rows('UPDATE suppliers SET archived_at=NULL WHERE id=$1', [fx.supplier.id]); }
});

test('documents can only be referenced by their own organisation (missing organisations never match)', async () => {
  const supplierActor = { id: String(fx.supplierUser.id), email: fx.supplierUser.email, role: 'supplier_user' as const, buyer_id: null };
  const [foreign] = await rows("INSERT INTO documents(file_name,mime_type,size_bytes,storage_key,sha256,uploaded_by,upload_status,scan_status,created_by,category) VALUES('lender.pdf','application/pdf',1,$1,$2,$3,'stored','pending',$3,'other') RETURNING id", [randomUUID(), 'a'.repeat(64), fx.financer.id]);
  const [own] = await rows("INSERT INTO documents(supplier_id,file_name,mime_type,size_bytes,storage_key,sha256,uploaded_by,upload_status,scan_status,created_by,category) VALUES($1,'mine.pdf','application/pdf',1,$2,$3,$4,'stored','pending',$4,'other') RETURNING id", [fx.supplier.id, randomUUID(), 'b'.repeat(64), fx.superAdmin.id]);
  await assert.rejects(transaction(db => validateFieldReferences('invoices', { supporting_documents: [{ document_id: String(foreign.id) }] }, supplierActor, db)), /outside your organisation/);
  await transaction(db => validateFieldReferences('invoices', { supporting_documents: [{ document_id: String(own.id) }] }, supplierActor, db));
});
