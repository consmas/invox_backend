// SRS Appendix B, increment 1 — Set-up and access (A1, F1, S1). Syndicate sets an anchor and a funder up from executed
// documentation behind a set-up gate, with named users provisioned but not activated; a supplier registers from an
// anchor's invitation. Permissions are correctly scoped and organisations are never duplicated.
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
import { pool, rows, insert } from '../src/server/db';
import { POST as uploadDocument } from '../src/app/api/portal/documents/route';

const connection = process.env.TEST_DATABASE_URL;
if (!connection || !new URL(connection).pathname.endsWith('_test')) throw new Error('Set TEST_DATABASE_URL to an isolated PostgreSQL database ending in _test.');
const admin = new Pool({ connectionString: connection });
const schema = `onboarding_test_${process.pid}_${Date.now()}`;
const url = new URL(connection);
url.searchParams.set('options', `-c search_path=${schema}`);
Object.assign(process.env, { DATABASE_URL: url.toString(), APP_URL: 'http://localhost:3000', NODE_ENV: 'test' });
delete process.env.SMTP_URL;

const tokens: Record<string, string> = {};
const fx: Record<string, any> = {};
async function request(method: string, path: string, body?: unknown, token?: string) {
  const res = await handleRequest(new NextRequest(`http://localhost:3000/api/${path}`, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { cookie: `invoix_token=${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), path.split('?')[0].split('/'));
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}
async function login(email: string, password = 'legacy-secret') {
  const res = await handleRequest(new NextRequest('http://localhost:3000/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }), ['auth', 'login']);
  assert.equal(res.status, 200, await res.clone().text());
  return res.headers.get('set-cookie')!.match(/invoix_token=([^;]+)/)![1];
}
async function upload(token: string) {
  const form = new FormData(); form.set('file', new File([`%PDF-1.4 ${randomUUID()}`], 'agreement.pdf', { type: 'application/pdf' })); form.set('category', 'executed_agreement');
  const res = await uploadDocument(new NextRequest('http://localhost:3000/api/portal/documents', { method: 'POST', headers: { cookie: `invoix_token=${token}` }, body: form }));
  const data = await res.json(); assert.equal(res.status, 201, JSON.stringify(data)); return String(data.id);
}
const today = new Date().toISOString().slice(0, 10);
const anchorBody = async (registration: string, extra: Record<string, unknown> = {}) => ({
  counterparty: 'ANCHOR',
  agreement: { reference: `SFA-${registration}`, executed_on: today, effective_on: today, document_ids: [await upload(tokens.ops)] },
  organisation: { legal_name: `${registration} Holdings Ltd`, trading_name: `${registration} Foods`, country: 'gh', registration_number: registration, sector: 'Food processing', registered_address: '1 Liberation Road, Accra', tax_id: 'C0001234567', erp_system: 'SAP S/4HANA', ...extra },
});

before(async () => {
  process.env.DOCUMENT_STORAGE_PATH = await mkdtemp(join(tmpdir(), 'invox-onboarding-'));
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const directory = new URL('../db/migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) await pool().query(await readFile(new URL(name, directory), 'utf8'));
  const hash = await bcrypt.hash('legacy-secret', 4);
  for (const name of ['ops', 'checker']) {
    fx[name] = await insert('users', { email: `${name}@example.test`, name, encrypted_password: hash, role: 2, jti: randomUUID() });
    tokens[name] = await login(`${name}@example.test`);
  }
  await rows('UPDATE users SET super_admin=true WHERE id=$1', [fx.ops.id]);
  // An anchor already live on the platform (set up before this process) with a released tender programme and a user.
  fx.liveBuyer = await insert('buyers', { name: 'Harbour Retail', registration_number: 'LIVE-1', contact_email: 'ap@harbour.test', country: 'GH' });
  fx.programme = (await rows("INSERT INTO programmes(buyer_id,name,\"limit\",fee_percent,maturity_days,currency,status) VALUES($1,'Harbour suppliers',500000,0,90,'GHS','active') RETURNING *", [fx.liveBuyer.id]))[0];
  fx.otherBuyer = await insert('buyers', { name: 'Coastal Mills', registration_number: 'LIVE-2', contact_email: 'ap@coastal.test', country: 'GH' });
  fx.otherProgramme = (await rows("INSERT INTO programmes(buyer_id,name,\"limit\",fee_percent,maturity_days,currency,status) VALUES($1,'Coastal suppliers',500000,0,90,'GHS','active') RETURNING *", [fx.otherBuyer.id]))[0];
  for (const [name, buyer, role] of [['anchorAdmin', fx.liveBuyer.id, 'administrator'], ['anchorViewer', fx.liveBuyer.id, 'viewer'], ['coastalAdmin', fx.otherBuyer.id, 'administrator']] as const) {
    fx[name] = await insert('users', { email: `${name.toLowerCase()}@example.test`, encrypted_password: hash, role: 0, buyer_id: buyer, jti: randomUUID() });
    await rows('UPDATE users SET org_role=$2,org_ref=$3 WHERE id=$1', [fx[name].id, role, `buyer-${buyer}`]);
    tokens[name] = await login(`${name.toLowerCase()}@example.test`);
  }
});
after(async () => {
  await pool().end();
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
  await rm(process.env.DOCUMENT_STORAGE_PATH!, { recursive: true, force: true });
});

test('A1: an anchor is created only behind the executed-agreement gate, never duplicated, and starts in set-up', async () => {
  // Only Syndicate; the organisation itself has no route in.
  assert.equal((await request('POST', 'portal/setup', await anchorBody('NOPE'), tokens.anchorAdmin)).status, 403);
  const gate = await anchorBody('ACME');
  assert.equal((await request('POST', 'portal/setup', { ...gate, agreement: { ...gate.agreement, document_ids: [] } }, tokens.ops)).status, 422, 'agreement document required');
  assert.equal((await request('POST', 'portal/setup', { ...gate, agreement: { ...gate.agreement, executed_on: '2999-01-01' } }, tokens.ops)).status, 422, 'not executed yet');
  const created = await request('POST', 'portal/setup', gate, tokens.ops);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  fx.anchorRef = created.data.ref; fx.anchorId = created.data.ref.split('-')[1];
  const [state] = await rows('SELECT status,legacy FROM organisation_lifecycle WHERE org_ref=$1', [fx.anchorRef]);
  assert.deepEqual([state.status, state.legacy], ['SETUP_IN_PROGRESS', false]);
  const [agreement] = await rows('SELECT reference,executed_on,document_ids FROM executed_agreements WHERE org_ref=$1', [fx.anchorRef]);
  assert.equal(agreement.reference, 'SFA-ACME');
  assert.equal((await rows('SELECT org_ref FROM documents WHERE id=$1', [agreement.document_ids[0]]))[0].org_ref, fx.anchorRef);

  // Same registration number and country, in any letter case, is the same organisation.
  const dup = await request('POST', 'portal/setup', await anchorBody('acme'), tokens.ops);
  assert.equal(dup.status, 409);
  assert.match(dup.data.error, /already on the platform/);

  const detail = (await request('GET', `portal/setup/${fx.anchorRef}`, undefined, tokens.ops)).data;
  assert.equal(detail.status, 'SETUP_IN_PROGRESS');
  assert.equal(detail.editable, true);
  for (const problem of ['administrator', 'approver', 'authorised signatory', 'commercial contact', 'finance contact', 'IT (data delivery) contact'])
    assert.ok(detail.setup_problems.some((p: string) => p.toLowerCase().includes(problem.toLowerCase())), problem);
});

test('A1.3–A1.5: named users are provisioned with roles but not activated; signatories and contacts are structured', async () => {
  const ref = fx.anchorRef;
  assert.equal((await request('POST', `portal/setup/${ref}/users`, { name: 'Yaw', email: 'yaw@acme.test', org_role: 'credit_officer' }, tokens.ops)).status, 422, 'funder role on an anchor');
  for (const [name, email, role] of [['Ama Mensah', 'ama@acme.test', 'administrator'], ['Kofi Boateng', 'kofi@acme.test', 'approver'], ['Efua Owusu', 'efua@acme.test', 'viewer']])
    assert.equal((await request('POST', `portal/setup/${ref}/users`, { name, email, org_role: role, job_title: 'Finance' }, tokens.ops)).status, 201);
  assert.equal((await request('POST', `portal/setup/${ref}/users`, { name: 'Ama again', email: 'AMA@acme.test', org_role: 'viewer' }, tokens.ops)).status, 409);
  const provisioned = await rows("SELECT email,org_role,provisioning_status,buyer_id FROM users WHERE org_ref=$1 ORDER BY id", [ref]);
  assert.deepEqual(provisioned.map(u => u.provisioning_status), ['PROVISIONED_NOT_ACTIVATED', 'PROVISIONED_NOT_ACTIVATED', 'PROVISIONED_NOT_ACTIVATED']);
  assert.ok(provisioned.every(u => String(u.buyer_id) === fx.anchorId));
  // Nothing is sent and nobody can sign in yet.
  assert.equal((await rows('SELECT count(*)::int AS n FROM user_invitations')).length && (await rows('SELECT count(*)::int AS n FROM user_invitations'))[0].n, 0);
  const signIn = await handleRequest(new NextRequest('http://localhost:3000/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ama@acme.test', password: 'anything-123' }) }), ['auth', 'login']);
  assert.equal(signIn.status, 401);

  // Signatories need evidence of their authority; contacts are recorded per purpose.
  assert.equal((await request('POST', `portal/setup/${ref}/signatories`, { name: 'Board Chair', scope: 'Variations and bank-detail changes' }, tokens.ops)).status, 422);
  const signatory = await request('POST', `portal/setup/${ref}/signatories`, { name: 'Abena Asante', title: 'Chief Financial Officer', scope: 'Variations, renewals and bank-detail changes', authority_limit: '5000000', evidence_clause: 'Board resolution 2026/04, clause 3' }, tokens.ops);
  assert.equal(signatory.status, 201, JSON.stringify(signatory.data));
  assert.equal((await request('PUT', `portal/setup/${ref}/contacts`, { contacts: [{ purpose: 'commercial', name: 'Ama Mensah', email: 'ama@acme.test' }, { purpose: 'commercial', name: 'Dup', email: 'd@acme.test' }] }, tokens.ops)).status, 422);
  assert.equal((await request('PUT', `portal/setup/${ref}/contacts`, { contacts: [{ purpose: 'commercial', name: 'Ama Mensah', email: 'ama@acme.test' }, { purpose: 'finance', name: 'Kofi Boateng', phone: '+233200000001' }, { purpose: 'it', name: 'Data Desk', email: 'erp@acme.test' }] }, tokens.ops)).status, 200);
  const detail = (await request('GET', `portal/setup/${ref}`, undefined, tokens.ops)).data;
  assert.deepEqual(detail.setup_problems, []);
  assert.equal(detail.signatories[0].evidence_clause, 'Board resolution 2026/04, clause 3');

  // Removing a provisioned person is allowed before activation.
  const viewer = provisioned.find(u => u.org_role === 'viewer')!;
  const [viewerRow] = await rows('SELECT id FROM users WHERE email=$1', [viewer.email]);
  assert.equal((await request('DELETE', `portal/setup/${ref}/users/${viewerRow.id}`, undefined, tokens.ops)).status, 200);
});

test('A1 status model: abandoning locks the record and re-opening restores it, each transition audited', async () => {
  const ref = fx.anchorRef;
  assert.equal((await request('POST', `portal/setup/${ref}/abandon`, { reason: 'short' }, tokens.ops)).status, 422);
  assert.equal((await request('POST', `portal/setup/${ref}/abandon`, { reason: 'Deal paused by the anchor board' }, tokens.ops)).status, 200);
  assert.equal((await request('PATCH', `portal/setup/${ref}`, { sector: 'Beverages' }, tokens.ops)).status, 409);
  assert.equal((await request('POST', `portal/setup/${ref}/abandon`, { reason: 'Deal paused by the anchor board' }, tokens.ops)).status, 200, 'idempotent');
  assert.equal((await request('POST', `portal/setup/${ref}/reopen`, { reason: 'Board approved the programme' }, tokens.ops)).status, 200);
  const updated = await request('PATCH', `portal/setup/${ref}`, { sector: 'Beverages', trading_name: 'Acme Drinks' }, tokens.ops);
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal(updated.data.name, 'Acme Drinks');
  const history = updated.data.history.map((h: any) => `${h.previous_status ?? '∅'}→${h.new_status}`);
  assert.deepEqual(history, ['∅→SETUP_IN_PROGRESS', 'SETUP_IN_PROGRESS→SETUP_ABANDONED', 'SETUP_ABANDONED→SETUP_IN_PROGRESS']);
  await assert.rejects(rows('DELETE FROM organisation_status_events'), /append-only/);
  // A programme cannot be released for an anchor that has not passed compliance.
  const programme = await request('POST', 'portal/manage/programmes', { name: 'Acme payables', buyer_id: fx.anchorId, limit: '1000000.00', fee_percent: '0', maturity_days: 90, currency: 'GHS', programme_reference: 'PRG-ACME', governing_law: 'Ghana', jurisdiction: 'Accra', financing_model: 'tender', buyer_acceptance_authority: 'buyer', allocation_policy: 'deterministic', financier_ids: [] }, tokens.ops);
  assert.equal(programme.status, 201, JSON.stringify(programme.data));
  assert.equal((await request('POST', `portal/manage/programmes/${programme.data.id}/submit`, { reason: 'Configured from executed agreement' }, tokens.ops)).status, 422);
});

test('F1: a funder is set up with its relationship owner and credit officers carrying recorded approval authority', async () => {
  const body = { counterparty: 'FUNDER', agreement: { reference: 'RPA-FIRSTCAP', executed_on: today, document_ids: [await upload(tokens.ops)] },
    organisation: { legal_name: 'First Capital Bank PLC', country: 'GH', registration_number: 'BANK-77', registered_address: 'Ridge, Accra', funder_type: 'bank', regulatory_status: 'Licensed universal bank (Bank of Ghana)', licence_reference: 'BoG/UB/0042' } };
  assert.equal((await request('POST', 'portal/setup', body, tokens.ops)).status, 422, 'relationship owner required');
  const created = await request('POST', 'portal/setup', { ...body, relationship_owner: { name: 'Esi Quaye', email: 'esi@firstcap.test' } }, tokens.ops);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const ref = created.data.ref; const ownerId = ref.split('-')[1];
  const [owner] = await rows('SELECT org_role,provisioning_status,role FROM users WHERE id=$1', [ownerId]);
  assert.deepEqual([owner.org_role, owner.provisioning_status, owner.role], ['relationship_owner', 'PROVISIONED_NOT_ACTIVATED', 3]);
  assert.equal((await request('POST', `portal/setup/${ref}/users`, { name: 'Ops', email: 'ops@firstcap.test', org_role: 'operations', approval_limit: '100' }, tokens.ops)).status, 422, 'authority only for credit officers');
  assert.equal((await request('POST', `portal/setup/${ref}/users`, { name: 'Kwame Credit', email: 'credit@firstcap.test', org_role: 'credit_officer' }, tokens.ops)).status, 201);
  let detail = (await request('GET', `portal/setup/${ref}`, undefined, tokens.ops)).data;
  assert.ok(detail.setup_problems.includes('Record each credit officer’s approval authority'));
  const credit = detail.users.find((u: any) => u.org_role === 'credit_officer');
  assert.equal((await request('PATCH', `portal/setup/${ref}/users/${credit.id}`, { approval_limit: '250000' }, tokens.ops)).status, 200);
  detail = (await request('GET', `portal/setup/${ref}`, undefined, tokens.ops)).data;
  assert.ok(!detail.setup_problems.some((p: string) => p.includes('approval authority')));
  assert.equal((await request('DELETE', `portal/setup/${ref}/users/${ownerId}`, undefined, tokens.ops)).status, 409, 'owner holds the record');
});

test('Syndicate roles: only the super administrator assigns them, and each set-up step needs its role', async () => {
  assert.equal((await request('PUT', `portal/setup/team/${fx.checker.id}/roles`, { roles: ['compliance_officer'] }, tokens.checker)).status, 403);
  assert.equal((await request('PUT', `portal/setup/team/${fx.checker.id}/roles`, { roles: ['compliance_officer'] }, tokens.ops)).status, 200);
  const team = (await request('GET', 'portal/setup/team', undefined, tokens.ops)).data;
  assert.deepEqual(team.operators.find((o: any) => String(o.id) === String(fx.checker.id)).ops_roles, ['compliance_officer']);
  const refused = await request('POST', 'portal/setup', await anchorBody('ROLE-1'), tokens.checker);
  assert.equal(refused.status, 403);
  assert.match(refused.data.error, /relationship manager/);
  assert.equal((await request('PUT', `portal/setup/team/${fx.checker.id}/roles`, { roles: null }, tokens.ops)).status, 200);
});

test('S1: an anchor invites suppliers by email or phone; existing suppliers are linked, never duplicated', async () => {
  assert.equal((await request('POST', 'portal/suppliers', { name: 'No Contact Ltd', programme_id: fx.programme.id }, tokens.anchorAdmin)).status, 422);
  assert.equal((await request('POST', 'portal/suppliers', { name: 'Viewer Try', email: 'v@x.test', programme_id: fx.programme.id }, tokens.anchorViewer)).status, 403, 'viewers are read-only');
  assert.equal((await request('POST', 'portal/suppliers', { name: 'Cross', email: 'c@x.test', programme_id: fx.otherProgramme.id }, tokens.anchorAdmin)).status, 403);

  // By email: the invitation names the anchor and pre-fills what the anchor knows.
  const byEmail = await request('POST', 'portal/suppliers', { name: 'Volta Packaging', email: 'AR@volta.test', registration_number: 'VP-9', country: 'GH', programme_id: fx.programme.id }, tokens.anchorAdmin);
  assert.equal(byEmail.status, 201, JSON.stringify(byEmail.data));
  assert.equal(byEmail.data.delivery.channel, 'email');
  const token = new URL(byEmail.data.preview_url).searchParams.get('token')!;
  const info = (await request('GET', `auth/invite?token=${token}`)).data;
  assert.deepEqual([info.anchor, info.programme, info.email, info.registration_number], ['Harbour Retail', 'Harbour suppliers', 'ar@volta.test', 'VP-9']);
  const supplierRef = `supplier-${byEmail.data.id}`;
  assert.equal((await rows('SELECT status FROM organisation_lifecycle WHERE org_ref=$1', [supplierRef]))[0].status, 'INVITED');
  assert.equal((await rows('SELECT status,channel FROM programme_enrolments WHERE supplier_id=$1', [byEmail.data.id]))[0].status, 'PENDING_ENROLMENT');

  // Registration from the link creates the supplier administrator and moves the organisation to REGISTERED.
  assert.equal((await request('POST', 'auth/signup', { email: 'someone@else.test', password: 'Supplier-password-1', role: 'supplier_user', invite_token: token })).status, 422);
  assert.equal((await request('POST', 'auth/signup', { email: 'ar@volta.test', password: 'Supplier-password-1', role: 'supplier_user', invite_token: token, name: 'Efua Owusu' })).status, 201);
  assert.equal((await request('POST', 'auth/signup', { email: 'ar@volta.test', password: 'Supplier-password-1', role: 'supplier_user', invite_token: token })).status, 422, 'single use');
  const [account] = await rows('SELECT org_role,org_ref,provisioning_status FROM users WHERE email=$1', ['ar@volta.test']);
  assert.deepEqual([account.org_role, account.org_ref, account.provisioning_status], ['administrator', supplierRef, 'ACTIVE']);
  assert.equal((await rows('SELECT status FROM organisation_lifecycle WHERE org_ref=$1', [supplierRef]))[0].status, 'REGISTERED');

  // Another anchor invites the same supplier (here by registration number): linked to the new programme, not duplicated.
  const again = await request('POST', 'portal/suppliers', { name: 'Volta Pack (Coastal)', phone: '0244000000', registration_number: 'vp-9', country: 'GH', programme_id: fx.otherProgramme.id }, tokens.coastalAdmin);
  assert.equal(again.status, 201, JSON.stringify(again.data));
  assert.equal(again.data.id, byEmail.data.id);
  assert.equal(again.data.delivery.channel, 'existing');
  assert.equal((await rows("SELECT count(*)::int AS n FROM suppliers WHERE registration_number ILIKE 'vp-9'"))[0].n, 1);
  const [notice] = await rows("SELECT body FROM notifications WHERE subject='New programme invitation' ORDER BY id DESC LIMIT 1");
  assert.match(notice.body, /Coastal Mills invited you to join Coastal suppliers/);
  assert.ok(!JSON.stringify(again.data).includes('Harbour'), 'the second anchor learns nothing about the first');

  // By phone only: SMS is not configured here, so the failure is reported rather than silent.
  const byPhone = await request('POST', 'portal/suppliers', { name: 'Tema Fresh', phone: '0244111222', programme_id: fx.programme.id }, tokens.anchorAdmin);
  assert.equal(byPhone.status, 201, JSON.stringify(byPhone.data));
  assert.deepEqual([byPhone.data.delivery.channel, byPhone.data.delivery.sent], ['sms', false]);
  assert.match(byPhone.data.warning, /SMS could not be sent/);
  assert.equal((await rows('SELECT delivery_status FROM programme_enrolments WHERE supplier_id=$1', [byPhone.data.id]))[0].delivery_status, 'failed');
  const phoneToken = new URL(byPhone.data.preview_url).searchParams.get('token')!;
  assert.equal((await request('POST', 'auth/signup', { email: 'owner@temafresh.test', password: 'Supplier-password-2', role: 'supplier_user', invite_token: phoneToken })).status, 201, 'any email when invited by phone');
  assert.equal((await rows('SELECT email FROM suppliers WHERE id=$1', [byPhone.data.id]))[0].email, 'owner@temafresh.test');

  // Released programmes only.
  const draft = (await rows("INSERT INTO programmes(buyer_id,name,\"limit\",fee_percent,maturity_days,currency,status) VALUES($1,'Draft',1000,0,30,'GHS','draft') RETURNING id", [fx.liveBuyer.id]))[0];
  assert.equal((await request('POST', 'portal/suppliers', { name: 'Early Bird', email: 'early@bird.test', programme_id: draft.id }, tokens.anchorAdmin)).status, 409);
});
