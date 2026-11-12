// Field completeness: every newly connected field is saved, returned on reload, validated, and
// server-assigned fields cannot be written through editable forms.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import { NextRequest } from 'next/server';
import { handleRequest } from '../src/server/http';
import { pool, rows, insert, transaction } from '../src/server/db';

const connection = process.env.TEST_DATABASE_URL;
if (!connection || !new URL(connection).pathname.endsWith('_test')) throw new Error('Set TEST_DATABASE_URL to an isolated PostgreSQL database ending in _test.');
const admin = new Pool({ connectionString: connection });
const schema = `fields_test_${process.pid}_${Date.now()}`;
const url = new URL(connection);
url.searchParams.set('options', `-c search_path=${schema}`);
Object.assign(process.env, { DATABASE_URL: url.toString(), APP_URL: 'http://localhost:3000', NODE_ENV: 'test' });

const fx: Record<string, any> = {};
const tokens: Record<string, string> = {};
async function request(method: string, path: string, body?: unknown, token?: string) {
  const res = await handleRequest(new NextRequest(`http://localhost:3000/api/${path}`, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { cookie: `invoix_token=${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), path.split('?')[0].split('/'));
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}
async function login(email: string) {
  const res = await handleRequest(new NextRequest('http://localhost:3000/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'legacy-secret' }) }), ['auth', 'login']);
  return res.headers.get('set-cookie')!.match(/invoix_token=([^;]+)/)![1];
}

before(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const directory = new URL('../db/migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) await pool().query(await readFile(new URL(name, directory), 'utf8'));
  const hash = await bcrypt.hash('legacy-secret', 4);
  await transaction(async db => {
    fx.buyer = await insert('buyers', { name: 'Buyer', registration_number: 'B-1', contact_email: 'b@example.test' }, db);
    for (const [name, role, buyer] of [['ops', 2, null], ['buyerAdmin', 0, fx.buyer.id], ['supplierUser', 1, null], ['financer', 3, null]] as const)
      fx[name] = await insert('users', { email: `${name.toLowerCase()}@example.test`, encrypted_password: hash, role, buyer_id: buyer, jti: randomUUID() }, db);
    fx.supplier = await insert('suppliers', { name: 'Supplier', email: fx.supplierUser.email, user_id: fx.supplierUser.id, contact_name: 'Legal contact' }, db);
    fx.programme = await insert('programmes', { name: 'Programme', buyer_id: fx.buyer.id, limit: '100000', fee_percent: '2', maturity_days: 30, currency: 'GHS', status: 'active', maximum_tenor_days: 3650, programme_reference: 'PRG-1', governing_law: 'Ghana', jurisdiction: 'Accra' }, db);
  });
  await rows('INSERT INTO financier_profiles(user_id,name,country,institution_type) VALUES($1,$2,$3,$4)', [fx.financer.id, 'Lender', 'GH', 'bank']);
  await rows('INSERT INTO portal_programme_suppliers VALUES($1,$2)', [fx.programme.id, fx.supplier.id]);
  await rows("INSERT INTO portal_supplier_relationships(buyer_id,supplier_id,contact_name,contact_email,payment_terms,notes) VALUES($1,$2,'AR desk','ar@example.test','Net 45','Quarterly review')", [fx.buyer.id, fx.supplier.id]);
  for (const name of ['ops', 'buyerAdmin', 'supplierUser', 'financer']) tokens[name] = await login(fx[name].email);
});
after(async () => {
  await pool().end();
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
});

test('organisation contact title persists for buyers, suppliers and financiers and reloads', async () => {
  const buyer = await request('PATCH', `buyers/${fx.buyer.id}`, { buyer: { contact_title: 'Head of Treasury', website: 'buyer.example', vat_number: 'VAT-9' } }, tokens.ops);
  assert.equal(buyer.status, 200, JSON.stringify(buyer.data));
  assert.equal((await request('GET', `buyers/${fx.buyer.id}`, undefined, tokens.ops)).data.contact_title, 'Head of Treasury');
  const supplier = await request('PATCH', `suppliers/${fx.supplier.id}`, { supplier: { contact_title: 'Finance Manager' } }, tokens.ops);
  assert.equal(supplier.status, 200, JSON.stringify(supplier.data));
  assert.equal((await request('GET', `suppliers/${fx.supplier.id}`, undefined, tokens.supplierUser)).data.contact_title, 'Finance Manager');
  const financier = await request('PATCH', `financers/${fx.financer.id}`, { financer: { contact_title: 'Credit Officer' } }, tokens.ops);
  assert.equal(financier.status, 200, JSON.stringify(financier.data));
  assert.equal((await request('GET', `financers/${fx.financer.id}`, undefined, tokens.financer)).data.contact_title, 'Credit Officer');
  assert.equal((await request('PATCH', `buyers/${fx.buyer.id}`, { buyer: { contact_title: 'x'.repeat(501) } }, tokens.ops)).status, 422);
  // Historical profiles without a title stay null rather than receiving a placeholder.
  const [legacy] = await rows('SELECT contact_title FROM financier_profiles WHERE user_id<>$1 LIMIT 1', [fx.financer.id]);
  assert.equal(legacy, undefined);
});

test('user job title persists through the account API and the profile endpoint', async () => {
  const updated = await request('PATCH', `users/${fx.supplierUser.id}`, { user: { job_title: 'Accounts Receivable Lead', name: 'Ama' } }, tokens.ops);
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal(updated.data.job_title, 'Accounts Receivable Lead');
  assert.equal((await request('GET', `users/${fx.supplierUser.id}`, undefined, tokens.ops)).data.job_title, 'Accounts Receivable Lead');
  const profile = await request('PATCH', 'portal/profile', { name: 'Esi Buyer', job_title: 'Treasurer', contact_phone: '+233 20 000 0000' }, tokens.buyerAdmin);
  assert.equal(profile.status, 200);
  assert.deepEqual([profile.data.user.job_title, profile.data.user.contact_phone], ['Treasurer', '+233 20 000 0000']);
});

test('invoice optional fields persist as exact decimals, reload, and stay null when unknown', async () => {
  const created = await request('POST', 'portal/manage/invoices', { programme_id: fx.programme.id, supplier_id: fx.supplier.id, invoice_number: 'FLD-1', amount: '1000.00', currency: 'GHS', payment_terms: 'Net 45 days', delivery_reference: 'GRN-77', tax_amount: '0.00', vat_amount: '150.25', financing_amount_requested: '900.01', industry: 'Packaging', country: 'GH', eligibility_reason: 'Delivered and accepted', payment_reference: 'PAY-77', risk_disclosures: 'Single buyer concentration' }, tokens.buyerAdmin);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const reloaded = (await request('GET', `invoices/${created.data.id}`, undefined, tokens.buyerAdmin)).data;
  assert.deepEqual([reloaded.payment_terms, reloaded.delivery_reference, reloaded.tax_amount, reloaded.vat_amount, reloaded.financing_amount_requested, reloaded.country, reloaded.payment_reference],
    ['Net 45 days', 'GRN-77', '0.00', '150.25', '900.01', 'GH', 'PAY-77']);
  assert.equal((await request('POST', 'portal/manage/invoices', { programme_id: fx.programme.id, supplier_id: fx.supplier.id, invoice_number: 'FLD-2', amount: '100.00', financing_amount_requested: '200.00' }, tokens.buyerAdmin)).status, 422);
  assert.equal((await request('POST', 'portal/manage/invoices', { programme_id: fx.programme.id, supplier_id: fx.supplier.id, invoice_number: 'FLD-3', vat_amount: '1.001' }, tokens.buyerAdmin)).status, 422);
  const sparse = await request('POST', 'portal/manage/invoices', { programme_id: fx.programme.id, supplier_id: fx.supplier.id, invoice_number: 'FLD-4' }, tokens.buyerAdmin);
  assert.equal(sparse.status, 201, JSON.stringify(sparse.data));
  const [row] = await rows('SELECT amount,due_date,payment_terms,tax_amount,description FROM invoices WHERE id=$1', [sparse.data.id]);
  assert.deepEqual(row, { amount: null, due_date: null, payment_terms: null, tax_amount: null, description: null });
  // Server-assigned fields cannot be supplied through the editable form.
  assert.equal((await request('PATCH', `portal/manage/invoices/${created.data.id}`, { cancellation_reason: 'forged' }, tokens.buyerAdmin)).status, 403);
  assert.equal((await request('PATCH', `portal/manage/invoices/${created.data.id}`, { invoice_number_normalized: 'FORGED' }, tokens.buyerAdmin)).status, 403);
});

test('offer proposed disbursement date is validated, persisted and read-only workflow facts cannot be forged', async () => {
  const invoice = await request('POST', 'portal/manage/invoices', { programme_id: fx.programme.id, supplier_id: fx.supplier.id, invoice_number: 'FLD-BID', amount: '1000.00', currency: 'GHS', issue_date: '2026-01-01', due_date: '2030-12-31', description: 'Goods', payment_terms: 'Net 30', financing_eligible: true }, tokens.buyerAdmin);
  assert.equal(invoice.status, 201, JSON.stringify(invoice.data));
  await rows("UPDATE invoices SET status='tender',invoice_approval_status='approved' WHERE id=$1", [invoice.data.id]);
  const [tender] = await rows("INSERT INTO financing_tenders(invoice_id,programme_id,tender_reference,currency,financing_amount_requested,opens_at,closes_at,maturity_date,eligible_conditions,risk_disclosures,published_by,published_at,status,created_by) VALUES($1,$2,'TND-F','GHS','1000',now(),now()+interval '5 days','2030-12-31','Invited','Disclosure',$3,now(),'open',$3) RETURNING id", [invoice.data.id, fx.programme.id, fx.ops.id]);
  await rows('INSERT INTO portal_tender_invitations VALUES($1,$2)', [tender.id, fx.financer.id]);
  const bid = { currency: 'GHS', discount_type: 'fixed', discount_fee: '10', other_fees: '0', day_count_basis: '365', expiry_date: '2030-12-01', amount: '900' };
  assert.equal((await request('POST', `invoices/${invoice.data.id}/bids`, { bid: { ...bid, proposed_disbursement_date: '2031-06-01' } }, tokens.financer)).status, 422);
  assert.equal((await request('POST', `invoices/${invoice.data.id}/bids`, { bid: { ...bid, portal_state: 'SUBMITTED' } }, tokens.financer)).status, 403);
  const created = await request('POST', `invoices/${invoice.data.id}/bids`, { bid: { ...bid, proposed_disbursement_date: '2030-06-01' } }, tokens.financer);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(String(created.data.proposed_disbursement_date).slice(0, 10), '2030-06-01');
  assert.equal(String((await rows('SELECT proposed_disbursement_date FROM bids WHERE id=$1', [created.data.id]))[0].proposed_disbursement_date).slice(0, 10), '2030-06-01');
});

test('relationship contacts are returned separately from the supplier legal profile', async () => {
  const bundle = await request('GET', 'portal/bootstrap', undefined, tokens.buyerAdmin);
  const supplier = bundle.data.suppliers.find((s: any) => String(s.id) === String(fx.supplier.id));
  assert.equal(supplier.contact_name, 'Legal contact');
  assert.deepEqual([supplier.relationship.contact_name, supplier.relationship.payment_terms, supplier.relationship.notes], ['AR desk', 'Net 45', 'Quarterly review']);
  assert.equal('tax_id' in supplier, false);
  const own = await request('GET', 'portal/bootstrap', undefined, tokens.supplierUser);
  assert.equal(own.data.suppliers[0].contact_title, 'Finance Manager');
  assert.equal(own.data.suppliers[0].relationship, undefined);
});

test('catalogue exposes the newly connected fields and marks workflow facts read-only', async () => {
  const defs = (entity: string) => request('GET', `field-definitions/${entity}`, undefined, tokens.ops).then(r => Object.fromEntries(r.data.fields.map((f: any) => [f.key, f])));
  const [buyers, users, bids, fundings, documents] = await Promise.all(['buyers', 'users', 'bids', 'fundings', 'documents'].map(defs));
  assert.equal(buyers.contact_title.readOnly, false);
  assert.equal(users.job_title.readOnly, false);
  assert.equal(bids.proposed_disbursement_date.type, 'date');
  for (const [entity, key] of [[fundings, 'confirmed_by'], [fundings, 'recorded_by'], [documents, 'review_status'], [bids, 'portal_state']] as const) assert.equal(entity[key].readOnly, true, key);
});
