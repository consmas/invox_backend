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
  const owner = { name: 'Esi Quaye', email: 'esi@firstcap.test' };
  const noPack = await request('POST', 'portal/setup', { ...body, entity_type: 'bank', relationship_owner: owner }, tokens.ops);
  assert.equal(noPack.status, 422, 'due-diligence pack required (FR-JNY-F-003)');
  assert.match(noPack.data.error, /before creating the funder/);
  const pack = [];
  for (const item of ['incorporation', 'constitution', 'regulatory_licence', 'signatory_authority', 'ownership_structure', 'source_of_funds', 'tax_documentation'])
    pack.push({ item_key: item, document_id: await upload(tokens.ops), expires_on: ['regulatory_licence', 'tax_documentation'].includes(item) ? '2030-12-31' : undefined });
  const created = await request('POST', 'portal/setup', { ...body, entity_type: 'bank', relationship_owner: owner, due_diligence: pack }, tokens.ops);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const ref = created.data.ref; const ownerId = ref.split('-')[1];
  const [ownerRow] = await rows('SELECT org_role,provisioning_status,role,mfa_required FROM users WHERE id=$1', [ownerId]);
  assert.deepEqual([ownerRow.org_role, ownerRow.provisioning_status, ownerRow.role, ownerRow.mfa_required], ['relationship_owner', 'PROVISIONED_NOT_ACTIVATED', 3, true]);
  assert.equal((await rows('SELECT count(*)::int AS n FROM compliance_documents WHERE org_ref=$1', [ref]))[0].n, 7);
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
  const supplierRef = `supplier-${byEmail.data.id}`; fx.voltaRef = supplierRef;
  assert.equal((await rows('SELECT status FROM organisation_lifecycle WHERE org_ref=$1', [supplierRef]))[0].status, 'INVITED');
  assert.equal((await rows('SELECT status,channel FROM programme_enrolments WHERE supplier_id=$1', [byEmail.data.id]))[0].status, 'PENDING_ENROLMENT');

  // Registration from the link creates the supplier administrator and moves the organisation to REGISTERED.
  assert.equal((await request('POST', 'auth/signup', { email: 'someone@else.test', password: 'Supplier-password-1', role: 'supplier_user', invite_token: token, accept_terms: true })).status, 422);
  assert.equal((await request('POST', 'auth/signup', { email: 'ar@volta.test', password: 'Supplier-password-1', role: 'supplier_user', invite_token: token, name: 'Efua Owusu' })).status, 422, 'consent required');
  assert.equal((await request('POST', 'auth/signup', { email: 'ar@volta.test', password: 'Supplier-password-1', role: 'supplier_user', invite_token: token, name: 'Efua Owusu', accept_terms: true, via: 'email' })).status, 201);
  const [consent] = await rows("SELECT c.context,c.terms_version FROM platform_consents c JOIN users u ON u.id=c.user_id WHERE u.email='ar@volta.test'");
  assert.deepEqual([consent.context, consent.terms_version], ['supplier_registration', '2026-11']);
  assert.equal((await rows('SELECT responded_channel FROM programme_enrolments WHERE supplier_id=$1', [byEmail.data.id]))[0].responded_channel, 'email');
  assert.equal((await request('POST', 'auth/signup', { email: 'ar@volta.test', password: 'Supplier-password-1', role: 'supplier_user', invite_token: token, accept_terms: true })).status, 422, 'single use');
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
  // Both invitations are logged against the supplier with their channel and outcome (§13.4).
  const logged = await rows("SELECT org_ref,channel,status FROM notifications WHERE event_type='supplier_invitation' ORDER BY id");
  assert.deepEqual(logged.map(n => `${n.org_ref}:${n.channel}:${n.status}`), [`${supplierRef}:email:skipped`, `supplier-${byPhone.data.id}:sms:failed`]);
  const phoneToken = new URL(byPhone.data.preview_url).searchParams.get('token')!; fx.temaRef = `supplier-${byPhone.data.id}`;
  assert.equal((await request('POST', 'auth/signup', { email: 'owner@temafresh.test', password: 'Supplier-password-2', role: 'supplier_user', invite_token: phoneToken, accept_terms: true, via: 'sms' })).status, 201, 'any email when invited by phone');
  assert.equal((await rows('SELECT email FROM suppliers WHERE id=$1', [byPhone.data.id]))[0].email, 'owner@temafresh.test');

  // Released programmes only.
  const draft = (await rows("INSERT INTO programmes(buyer_id,name,\"limit\",fee_percent,maturity_days,currency,status) VALUES($1,'Draft',1000,0,30,'GHS','draft') RETURNING id", [fx.liveBuyer.id]))[0];
  assert.equal((await request('POST', 'portal/suppliers', { name: 'Early Bird', email: 'early@bird.test', programme_id: draft.id }, tokens.anchorAdmin)).status, 409);
});

// ── increment 2: the compliance gate (A2, F1.7–F1.8, S2) ─────────────────────
async function uploadImage(token: string, width: number, height: number) {
  const png = Buffer.alloc(64); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png); png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(width, 16); png.writeUInt32BE(height, 20);
  const form = new FormData(); form.set('file', new File([png, randomUUID()], 'photo.png', { type: 'image/png' })); form.set('category', 'photo');
  const res = await uploadDocument(new NextRequest('http://localhost:3000/api/portal/documents', { method: 'POST', headers: { cookie: `invoix_token=${token}` }, body: form }));
  return { status: res.status, data: await res.json() };
}
const inDays = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
async function fileChecklist(ref: string, token: string) {
  const file = (await request('GET', `portal/compliance/${ref}`, undefined, token)).data;
  for (const item of file.checklist.filter((i: any) => i.state !== 'filed'))
    assert.equal((await request('POST', `portal/compliance/${ref}/documents`, { item_key: item.key, document_id: await upload(token), issued_on: today, expires_on: item.expires ? inDays(365) : undefined }, token)).status, 201, item.key);
}
async function screenAll(ref: string, token: string, except?: string) {
  const file = (await request('GET', `portal/compliance/${ref}`, undefined, tokens.ops)).data;
  for (const subject of file.screening.filter((s: any) => s.state === 'not_screened'))
    assert.equal((await request('POST', `portal/compliance/${ref}/screening`, { subject_type: subject.type, subject_name: subject.name, outcome: subject.name === except ? 'potential_match' : 'clear', reference: 'MANUAL-SCREEN-1' }, token)).status, 201);
}

test('A2: the anchor compliance file is complete, screened and independently signed off before it is verified', async () => {
  const ref = fx.anchorRef;
  let file = (await request('GET', `portal/compliance/${ref}`, undefined, tokens.ops)).data;
  assert.ok(file.checklist.length >= 5);
  assert.ok(file.submission_problems.some((p: string) => p.startsWith('File the certificate of incorporation')));
  assert.equal((await request('GET', `portal/compliance/${ref}`, undefined, tokens.anchorAdmin)).status, 403, 'the anchor has no access during set-up');
  assert.equal((await request('POST', `portal/compliance/${ref}/submit`, {}, tokens.ops)).status, 422);

  // Documents: an expiring item needs a future expiry date.
  assert.equal((await request('POST', `portal/compliance/${ref}/documents`, { item_key: 'registered_address', document_id: await upload(tokens.ops) }, tokens.ops)).status, 422);
  assert.equal((await request('POST', `portal/compliance/${ref}/documents`, { item_key: 'registered_address', document_id: await upload(tokens.ops), expires_on: '2001-01-01' }, tokens.ops)).status, 422);
  assert.equal((await request('POST', `portal/compliance/${ref}/documents`, { item_key: 'not_on_the_list', document_id: await upload(tokens.ops) }, tokens.ops)).status, 422);
  await fileChecklist(ref, tokens.ops);

  // Ownership must resolve to natural persons above the threshold, with at least one director.
  const holding = await request('POST', `portal/compliance/${ref}/owners`, { kind: 'entity', name: 'Acme Group Holdings', ownership_percent: 60 }, tokens.ops);
  assert.equal(holding.status, 201);
  file = (await request('GET', `portal/compliance/${ref}`, undefined, tokens.ops)).data;
  assert.ok(file.submission_problems.some((p: string) => p.includes('Acme Group Holdings holds 60.0%')));
  assert.ok(file.submission_problems.includes('Record at least one director'));
  const amaOwner = await request('POST', `portal/compliance/${ref}/owners`, { kind: 'natural', name: 'Ama Owner', nationality: 'GH', ownership_percent: 100, parent_id: holding.data.id }, tokens.ops);
  assert.equal(amaOwner.status, 201);
  file = (await request('GET', `portal/compliance/${ref}`, undefined, tokens.ops)).data;
  assert.ok(file.submission_problems.includes('Attach the supporting evidence for beneficial owner Ama Owner'));
  assert.equal((await request('DELETE', `portal/compliance/${ref}/owners/${amaOwner.data.id}`, undefined, tokens.ops)).status, 200);
  assert.equal((await request('POST', `portal/compliance/${ref}/owners`, { kind: 'natural', name: 'Ama Owner', nationality: 'GH', ownership_percent: 100, parent_id: holding.data.id, evidence_document_id: await upload(tokens.ops) }, tokens.ops)).status, 201);
  assert.equal((await request('POST', `portal/compliance/${ref}/owners`, { kind: 'entity', name: 'Bad', is_director: true }, tokens.ops)).status, 422);
  assert.equal((await request('POST', `portal/compliance/${ref}/owners`, { kind: 'natural', name: 'Kwesi Director', is_director: true }, tokens.ops)).status, 201);
  file = (await request('GET', `portal/compliance/${ref}`, undefined, tokens.ops)).data;
  assert.equal(file.owners.find((o: any) => o.name === 'Ama Owner').effective_percent, 60);

  // Settlement account with evidence; a malformed number is refused.
  const evidence = await upload(tokens.ops);
  assert.equal((await request('POST', `portal/compliance/${ref}/accounts`, { bank_name: 'GCB Bank', account_number: '12', account_name: 'ACME Holdings Ltd', evidence_document_id: evidence }, tokens.ops)).status, 422);
  const account = await request('POST', `portal/compliance/${ref}/accounts`, { bank_name: 'GCB Bank', bank_code: '040100', account_number: '1011 2233 4455', account_name: 'ACME Holdings Ltd', evidence_document_id: evidence, name_check: 'match' }, tokens.ops);
  assert.equal(account.status, 201, JSON.stringify(account.data));

  // Screening: every party, a potential match opens a task and blocks submission until a different person resolves it.
  await screenAll(ref, tokens.ops, 'Kwesi Director');
  file = (await request('GET', `portal/compliance/${ref}`, undefined, tokens.ops)).data;
  assert.deepEqual(file.screening.map((s: any) => s.type).sort(), ['individual', 'individual', 'organisation', 'signatory']);
  assert.ok(file.submission_problems.includes('Resolve the potential screening match for Kwesi Director'));
  assert.equal((await rows("SELECT count(*)::int AS n FROM portal_exceptions WHERE org_ref=$1 AND kind='COMPLIANCE_REVIEW'", [ref]))[0].n, 1);
  const hit = file.screening.find((s: any) => s.state === 'potential_match').latest;
  assert.equal((await request('POST', `portal/compliance/${ref}/screening/${hit.id}/resolve`, { resolution: 'false_positive', note: 'Different date of birth and nationality' }, tokens.ops)).status, 403, 'not the recorder');
  assert.equal((await request('POST', `portal/compliance/${ref}/screening/${hit.id}/resolve`, { resolution: 'false_positive', note: 'Different date of birth and nationality' }, tokens.checker)).status, 200);

  // Submit → compliance review; the file locks.
  const submitted = await request('POST', `portal/compliance/${ref}/submit`, {}, tokens.ops);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
  assert.equal(submitted.data.status, 'COMPLIANCE_REVIEW');
  assert.equal((await request('POST', `portal/compliance/${ref}/owners`, { kind: 'natural', name: 'Late', is_director: true }, tokens.ops)).status, 409);

  // The submitter cannot decide; sign-off needs the verified account; the recorder cannot verify the account.
  assert.equal((await request('POST', `portal/compliance/${ref}/decide`, { decision: 'sign_off', risk_rating: 'medium' }, tokens.ops)).status, 403);
  const early = await request('POST', `portal/compliance/${ref}/decide`, { decision: 'sign_off', risk_rating: 'medium' }, tokens.checker);
  assert.equal(early.status, 422);
  assert.match(early.data.error, /Verify the account the anchor settles/);
  assert.equal((await request('POST', `portal/compliance/${ref}/accounts/${account.data.id}/verify`, { decision: 'verify' }, tokens.ops)).status, 403);
  assert.equal((await request('POST', `portal/compliance/${ref}/accounts/${account.data.id}/verify`, { decision: 'verify' }, tokens.checker)).status, 200);
  const [verifiedAccount] = await rows('SELECT status,usable_from > now() AS cooling FROM settlement_accounts WHERE id=$1', [account.data.id]);
  assert.deepEqual([verifiedAccount.status, verifiedAccount.cooling], ['VERIFIED', true]);
  assert.equal((await request('POST', `portal/compliance/${ref}/decide`, { decision: 'sign_off' }, tokens.checker)).status, 422, 'risk rating required');
  const signed = await request('POST', `portal/compliance/${ref}/decide`, { decision: 'sign_off', risk_rating: 'medium' }, tokens.checker);
  assert.equal(signed.status, 200, JSON.stringify(signed.data));
  const [state] = await rows("SELECT status,risk_rating,re_verification_due::text AS due FROM organisation_lifecycle WHERE org_ref=$1", [ref]);
  assert.deepEqual([state.status, state.risk_rating], ['VERIFIED', 'medium']);
  assert.ok(state.due > inDays(700) && state.due < inDays(740), state.due);
  assert.equal((await rows('SELECT status FROM portal_org_reviews WHERE org_ref=$1', [ref]))[0].status, 'APPROVED');
  const history = (await request('GET', `portal/setup/${ref}`, undefined, tokens.ops)).data.history.map((h: any) => h.new_status);
  assert.deepEqual(history.slice(-2), ['COMPLIANCE_REVIEW', 'VERIFIED']);

  // A later bank-account change needs a recorded signatory and supersedes the old account once verified.
  const evidence2 = await upload(tokens.ops);
  assert.equal((await request('POST', `portal/compliance/${ref}/accounts`, { bank_name: 'Stanbic', account_number: '9040001112223', account_name: 'ACME Holdings Ltd', evidence_document_id: evidence2 }, tokens.ops)).status, 422);
  const [signatory] = await rows('SELECT id FROM authorised_signatories WHERE org_ref=$1', [ref]);
  const change = await request('POST', `portal/compliance/${ref}/accounts`, { bank_name: 'Stanbic', account_number: '9040001112223', account_name: 'ACME Holdings Ltd', evidence_document_id: evidence2, authorised_by_signatory_id: signatory.id }, tokens.ops);
  assert.equal(change.status, 201, JSON.stringify(change.data));
  assert.equal((await request('POST', `portal/compliance/${ref}/accounts/${change.data.id}/verify`, { decision: 'verify' }, tokens.checker)).status, 200);
  assert.deepEqual((await rows('SELECT status FROM settlement_accounts WHERE org_ref=$1 ORDER BY id', [ref])).map(a => a.status), ['SUPERSEDED', 'VERIFIED']);
});

test('S2: a supplier verifies itself from a phone, is referred back with itemised gaps, then signed off', async () => {
  const ref = fx.voltaRef;
  const supplier = await login('ar@volta.test', 'Supplier-password-1');
  assert.equal((await request('GET', `portal/compliance/${fx.anchorRef}`, undefined, supplier)).status, 403, 'only its own file');
  let file = (await request('GET', `portal/compliance/${ref}`, undefined, supplier)).data;
  assert.equal(file.tier, 'simplified');
  assert.equal(file.screening, undefined, 'screening detail is internal');
  assert.deepEqual(file.checklist.map((i: any) => i.key), ['incorporation', 'individual_ids']);

  // Photos are checked for legibility at upload.
  const blurry = await uploadImage(supplier, 320, 240);
  assert.equal(blurry.status, 422);
  assert.match(blurry.data.error, /too small to read/);
  const photo = await uploadImage(supplier, 1600, 1200);
  assert.equal(photo.status, 201, JSON.stringify(photo.data));

  // Company details confirmed by the supplier; never a duplicate of an existing organisation.
  assert.equal((await request('PATCH', `portal/compliance/${ref}/profile`, { registration_number: 'acme', country: 'GH' }, supplier)).status, 409);
  assert.equal((await request('PATCH', `portal/compliance/${ref}/profile`, { legal_name: 'Volta Packaging Limited', registered_address: '4 Harbour Road, Tema', tax_id: 'P0012345678' }, supplier)).status, 200);
  assert.equal((await request('POST', `portal/compliance/${ref}/documents`, { item_key: 'incorporation', document_id: photo.data.id }, supplier)).status, 201);
  assert.equal((await request('POST', `portal/compliance/${ref}/owners`, { kind: 'natural', name: 'Efua Owusu', nationality: 'GH', ownership_percent: 100, is_director: true }, supplier)).status, 201);
  // Bank account: self-service at first onboarding; a name that differs from the legal entity is flagged for review.
  const account = await request('POST', `portal/compliance/${ref}/accounts`, { bank_name: 'Ecobank', account_number: '1441000123456', account_name: 'Efua Owusu', evidence_document_id: await upload(supplier) }, supplier);
  assert.equal(account.status, 201, JSON.stringify(account.data));
  assert.equal(account.data.name_check, 'mismatch');
  file = (await request('GET', `portal/compliance/${ref}`, undefined, supplier)).data;
  assert.deepEqual(file.submission_problems, ['File the identification of each director']);
  await fileChecklist(ref, supplier);
  assert.equal((await request('POST', `portal/compliance/${ref}/submit`, {}, supplier)).status, 200);
  assert.equal((await request('POST', `portal/compliance/${ref}/documents`, { item_key: 'incorporation', document_id: await upload(supplier) }, supplier)).status, 409, 'locked while in review');

  // Syndicate screens during review, then refers back with exactly what is missing.
  await screenAll(ref, tokens.ops);
  assert.equal((await request('POST', `portal/compliance/${ref}/decide`, { decision: 'refer' }, tokens.checker)).status, 422, 'itemised list required');
  assert.equal((await request('POST', `portal/compliance/${ref}/decide`, { decision: 'refer', outstanding_items: ['A clearer copy of the director’s Ghana Card, both sides'] }, tokens.checker)).status, 200);
  file = (await request('GET', `portal/compliance/${ref}`, undefined, supplier)).data;
  assert.equal(file.status, 'INFO_REQUIRED');
  assert.deepEqual(file.reviews[0].outstanding_items, ['A clearer copy of the director’s Ghana Card, both sides']);
  const [told] = await rows("SELECT body FROM notifications WHERE subject='We need a little more information' ORDER BY id DESC LIMIT 1");
  assert.match(told.body, /Ghana Card/);
  assert.equal((await request('POST', `portal/compliance/${ref}/documents`, { item_key: 'individual_ids', document_id: await upload(supplier), expires_on: inDays(900) }, supplier)).status, 201);
  assert.equal((await request('POST', `portal/compliance/${ref}/submit`, {}, supplier)).status, 200);

  // The mismatched account name needs a recorded justification before it can be verified; then sign-off.
  assert.equal((await request('POST', `portal/compliance/${ref}/accounts/${account.data.id}/verify`, { decision: 'verify' }, tokens.ops)).status, 422);
  assert.equal((await request('POST', `portal/compliance/${ref}/accounts/${account.data.id}/verify`, { decision: 'verify', note: 'Sole proprietor account confirmed by bank letter' }, tokens.ops)).status, 200);
  assert.equal((await request('POST', `portal/compliance/${ref}/decide`, { decision: 'sign_off', risk_rating: 'low' }, tokens.checker)).status, 200);
  const session = (await request('GET', 'portal/session', undefined, supplier)).data;
  assert.equal(session.needs_onboarding, false);
  assert.equal(session.lifecycle.status, 'VERIFIED');
  // A verified account can no longer be changed in the portal (S2.4 → S7).
  const again = await request('POST', `portal/compliance/${ref}/accounts`, { bank_name: 'Fidelity', account_number: '2000300040005', account_name: 'Volta Packaging Limited', evidence_document_id: await upload(supplier) }, supplier);
  assert.equal(again.status, 409);
  // The anchor sees the stage only: no documents, screening or account detail.
  const anchorView = JSON.stringify((await request('GET', 'portal/bootstrap', undefined, tokens.anchorAdmin)).data);
  assert.ok(!anchorView.includes('1441000123456') && !anchorView.includes('MANUAL-SCREEN-1'));
});

test('S2.6: a declined supplier sees a neutral outcome; the reason stays internal', async () => {
  const ref = fx.temaRef;
  const supplier = await login('owner@temafresh.test', 'Supplier-password-2');
  await request('PATCH', `portal/compliance/${ref}/profile`, { legal_name: 'Tema Fresh Ltd', registration_number: 'TF-1', country: 'GH', registered_address: 'Community 1, Tema' }, supplier);
  await fileChecklist(ref, supplier);
  await request('POST', `portal/compliance/${ref}/owners`, { kind: 'natural', name: 'Nii Tetteh', is_director: true, ownership_percent: 100 }, supplier);
  await request('POST', `portal/compliance/${ref}/accounts`, { bank_name: 'GCB', account_number: '1022003004005', account_name: 'Tema Fresh Ltd', evidence_document_id: await upload(supplier) }, supplier);
  assert.equal((await request('POST', `portal/compliance/${ref}/submit`, {}, supplier)).status, 200);
  assert.equal((await request('POST', `portal/compliance/${ref}/decide`, { decision: 'decline', note: 'Director appears on an adverse-media list (internal reference AM-77)' }, tokens.checker)).status, 200);
  const file = (await request('GET', `portal/compliance/${ref}`, undefined, supplier)).data;
  assert.equal(file.status, 'DECLINED');
  assert.ok(!JSON.stringify(file).includes('AM-77'));
  assert.equal((await rows('SELECT note FROM portal_org_reviews WHERE org_ref=$1', [ref]))[0].note, null);
  // The older verification queue cannot bypass the compliance file.
  assert.equal((await request('POST', `portal/verification/${ref}`, { status: 'APPROVED' }, tokens.ops)).status, 409);
});

// ── alignment review: requirements the first two increments had not fully met ─
test('FR-JNY-A-003/S-004: the checklist follows jurisdiction, entity type and tier, with explicit exclusions', async () => {
  const anchor = await request('POST', 'portal/setup', await anchorBody('PART-1', {}), tokens.ops);
  // Default (limited company) anchors file a constitution; partnerships file a partnership deed instead.
  const limited = (await request('GET', `portal/compliance/${anchor.data.ref}`, undefined, tokens.ops)).data;
  assert.ok(limited.checklist.some((i: any) => i.key === 'constitution'));
  const partnership = await request('POST', 'portal/setup', { ...(await anchorBody('PART-2')), entity_type: 'partnership' }, tokens.ops);
  const deed = (await request('GET', `portal/compliance/${partnership.data.ref}`, undefined, tokens.ops)).data;
  assert.equal(deed.entity_type, 'partnership');
  assert.ok(deed.checklist.some((i: any) => i.key === 'partnership_deed'));
  assert.ok(!deed.checklist.some((i: any) => i.key === 'constitution'));
  assert.equal((await request('POST', 'portal/setup', { ...(await anchorBody('PART-3')), entity_type: 'spaceship' }, tokens.ops)).status, 422);
});

test('S2.5/S-029/A2.5: anchors see stage only; a verified supplier account changes only on a signed request, with three notices', async () => {
  const [stage] = await rows("SELECT body FROM notifications WHERE event_type='supplier_onboarding' AND body LIKE 'Volta Packaging Limited is verified%' LIMIT 1");
  assert.ok(stage, 'the inviting anchor was told the supplier is verified');
  const anchorNotices = await rows("SELECT body FROM notifications n JOIN users u ON u.id=n.user_id WHERE u.buyer_id=$1 AND n.event_type='supplier_onboarding'", [fx.liveBuyer.id]);
  assert.ok(anchorNotices.every(n => !/Ghana Card|1441000123456|screen/i.test(n.body)), 'stage only, never documents or detail');
  const ref = fx.voltaRef;
  const evidence = await upload(tokens.ops);
  assert.equal((await request('POST', `portal/compliance/${ref}/accounts`, { bank_name: 'Fidelity', account_number: '2000300040005', account_name: 'Volta Packaging Limited', evidence_document_id: evidence }, tokens.ops)).status, 422, 'signed request required');
  const change = await request('POST', `portal/compliance/${ref}/accounts`, { bank_name: 'Fidelity', account_number: '2000300040005', account_name: 'Volta Packaging Limited', evidence_document_id: evidence, request_document_id: await upload(tokens.ops) }, tokens.ops);
  assert.equal(change.status, 201, JSON.stringify(change.data));
  assert.equal((await request('POST', `portal/compliance/${ref}/accounts/${change.data.id}/verify`, { decision: 'verify' }, tokens.checker)).status, 200);
  const [supplierUser] = await rows("SELECT id FROM users WHERE email='ar@volta.test'");
  const notices = await rows("SELECT subject,channel FROM notifications WHERE user_id=$1 AND event_type='bank_account_change' ORDER BY id", [supplierUser.id]);
  assert.deepEqual([...new Set(notices.map(n => n.subject))], ['A change to your bank account is under review', 'Your bank account was changed']);
  assert.ok(notices.some(n => n.channel === 'email'), 'never suppressible: emailed as well as in-app');
  const relationshipNotices = await rows("SELECT 1 FROM notifications n JOIN users u ON u.id=n.user_id WHERE u.role=2 AND n.event_type='bank_account_change'");
  assert.ok(relationshipNotices.length >= 2, 'the relationship manager is told too');
});

test('Onboarding diary: stalled suppliers are reminded on schedule; email is queued and never silently lost', async () => {
  const { onboardingReminders, dispatchNotifications } = await import('../src/server/onboarding/diary');
  const invited = await request('POST', 'portal/suppliers', { name: 'Slow Supplies', email: 'slow@supplies.test', programme_id: fx.programme.id }, tokens.anchorAdmin);
  assert.equal(invited.status, 201, JSON.stringify(invited.data));
  assert.equal(await onboardingReminders(new Date()), 0, 'not due yet');
  const later = new Date(Date.now() + 4 * 86400000);
  assert.ok(await onboardingReminders(later) >= 1);
  const [enrolment] = await rows('SELECT reminders_sent FROM programme_enrolments WHERE supplier_id=$1', [invited.data.id]);
  assert.equal(enrolment.reminders_sent, 1);
  assert.equal(await onboardingReminders(later), 0, 'next reminder only at the next scheduled interval');
  const [queued] = await rows("SELECT subject,body FROM notifications WHERE recipient='slow@supplies.test' AND channel='email' AND event_type='onboarding_reminder'");
  assert.match(queued.subject, /Finish setting up INVOX for Harbour Retail/);
  const [toAnchor] = await rows("SELECT body FROM notifications WHERE user_id=$1 AND subject='Supplier onboarding stalled' ORDER BY id DESC LIMIT 1", [fx.anchorAdmin.id]);
  assert.match(toAnchor.body, /Slow Supplies has not finished creating its log-in/);
  // Without a mail server (this environment) queued email is marked skipped rather than "delivered".
  await dispatchNotifications();
  assert.equal((await rows("SELECT count(*)::int AS n FROM notifications WHERE channel='email' AND status='delivered'"))[0].n, 0);
  assert.ok((await rows("SELECT count(*)::int AS n FROM notifications WHERE channel='email' AND status='skipped'"))[0].n > 0);
});

test('S1.3/NFR-SEC-002: invited people must enrol a second factor; the audit trail records where actions came from', async () => {
  Object.assign(process.env, { REQUIRE_OPERATIONS_MFA: 'true', CLIENT_IP_HEADER: 'x-real-ip' });
  try {
    const supplier = await login('ar@volta.test', 'Supplier-password-1');
    const session = (await request('GET', 'portal/session', undefined, supplier)).data;
    assert.equal(session.mfa_enrolment_required, true);
    assert.equal((await request('GET', 'portal/bootstrap', undefined, supplier)).status, 403);
    const res = await handleRequest(new NextRequest('http://localhost:3000/api/portal/compliance/' + fx.anchorRef + '/screening', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: `invoix_token=${await login('checker@example.test')}`, 'x-real-ip': '196.200.10.7' }, body: JSON.stringify({ subject_type: 'organisation', subject_name: 'Acme Holdings Ltd', outcome: 'clear', reference: 'IP-TEST' }) }), ['portal', 'compliance', fx.anchorRef, 'screening']);
    assert.equal(res.status, 403, 'operations must verify their own authenticator first');
  } finally { delete process.env.REQUIRE_OPERATIONS_MFA; }
  try {
    const res = await handleRequest(new NextRequest('http://localhost:3000/api/portal/compliance/' + fx.anchorRef + '/screening', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: `invoix_token=${tokens.checker}`, 'x-real-ip': '196.200.10.7' }, body: JSON.stringify({ subject_type: 'organisation', subject_name: 'Acme Holdings Ltd', outcome: 'clear', reference: 'IP-TEST' }) }), ['portal', 'compliance', fx.anchorRef, 'screening']);
    assert.equal(res.status, 201, await res.clone().text());
    const [event] = await rows("SELECT ip FROM portal_events WHERE event='compliance.screened' ORDER BY id DESC LIMIT 1");
    assert.equal(event.ip, '196.200.10.7');
  } finally { delete process.env.CLIENT_IP_HEADER; }
});
