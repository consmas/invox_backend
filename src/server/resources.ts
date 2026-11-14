import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { insert, update, rows, transaction, pool, type DB, type Row } from './db';
import { type Actor, publicUser, requireRole, hashPassword, revokeSessions, newToken, digest } from './auth';
import { ApiError, requireCondition } from './errors';
import { id, roles, userInput, email, password, bidStatuses } from './validation';
import { appUrl, sendLink, requireMailConfiguration } from './mail';
import { assertFinancialRelease } from './finance';
import { audit } from './audit';
import { preparedOnBehalfBy } from './act-for';
import { assertFresh } from './context';
import { cents,discountQuote } from './money';
import { coreSchema,fieldSchema,fieldCatalog,rejectManagedFields,databaseValues,validateFieldReferences,entityAudit } from './fields';

export type Result = { data?: unknown; status?: number };
type Input = Record<string, unknown>;
const userProfileColumns=['name','job_title','contact_phone','country','preferred_language','timezone','recert_cycle','mfa_enrolled_at','mfa_verified_at','last_successful_login_at','dormancy_suspended_at','last_recertified_at'];
const userColumns = ['id','email','role','buyer_id','created_at','updated_at',...userProfileColumns].join(',');
const supplierColumns = ['id','email','email AS contact_email','user_id','invited_at','created_at','updated_at',...fieldCatalog.suppliers.fields.filter(field=>!field.transient&&field.key!=='contact_email').map(field=>`"${field.key}"`)].join(',');
// Counterparties never receive tax, address, screening or risk assessment fields (F03).
const supplierPartnerColumns = 'id,name,legal_name,trading_name,country,registration_number,email AS contact_email,contact_name,contact_phone,preferred_currency,created_at,updated_at';
const supplierPublicColumns = 'id,name,legal_name,trading_name,country,created_at';
/** Financiers see an invoice only through their own offer or a current invitation to its tender (F02). */
const financerVisible = (user: string) => `(EXISTS(SELECT 1 FROM bids d WHERE d.invoice_id=i.id AND d.financer_id=${user}) OR i.status='tender' AND EXISTS(SELECT 1 FROM financing_tenders t JOIN portal_tender_invitations ti ON ti.tender_id=t.id WHERE t.invoice_id=i.id AND ti.financer_id=${user}))`;
const invoiceSelect = `SELECT i.*, p.buyer_id, p.name AS programme_name, b.name AS buyer_name,
  (SELECT d.financer_id FROM bids d WHERE d.invoice_id=i.id AND d.status=1) AS accepted_financer_id,
  json_build_object('id',s.id,'name',s.name,'email',s.email,'user_id',s.user_id) AS supplier
  FROM invoices i JOIN programmes p ON p.id=i.programme_id JOIN buyers b ON b.id=p.buyer_id JOIN suppliers s ON s.id=i.supplier_id`;
const bidSelect = `SELECT d.*, u.email AS financer_name, u.email AS financer_email, p.buyer_id, s.user_id AS supplier_user_id,
  i.status AS invoice_status, i.amount AS invoice_amount, p.name AS programme_name
  FROM bids d JOIN users u ON u.id=d.financer_id JOIN invoices i ON i.id=d.invoice_id
  JOIN programmes p ON p.id=i.programme_id JOIN suppliers s ON s.id=i.supplier_id`;

export function parseId(value: unknown): string { return id.parse(value); }
function payload(body: Input, key: string): Input {
  const value = body[key] ?? body;
  return z.record(z.string(), z.unknown()).parse(value);
}
function found<T>(value: T | undefined): T { requireCondition(value, 404, 'Not found'); return value; }
function same(a: unknown, b: unknown) { return String(a) === String(b); }
function ownBuyer(actor: Actor, buyerId: unknown) {
  requireCondition(actor.role === 'platform_ops' || (actor.role === 'buyer_admin' && same(actor.buyer_id, buyerId)), 403, 'Forbidden');
}
async function buyerFor(actor: Actor, buyerId: string, db: DB) {
  ownBuyer(actor, buyerId);
  return found((await rows('SELECT * FROM buyers WHERE id=$1', [buyerId], db))[0]);
}
async function programmeFor(actor: Actor, programmeId: string, buyerId: string | undefined, db: DB) {
  const record = found((await rows('SELECT * FROM programmes WHERE id=$1', [programmeId], db))[0]);
  if (buyerId) requireCondition(same(record.buyer_id, buyerId), 404, 'Not found');
  ownBuyer(actor, record.buyer_id);
  return record;
}
/** Same rule as the management workflow: the supplier must be on the programme with an active buyer relationship. */
async function requireProgrammeSupplier(programmeId: string, supplierId: string, db: DB) {
  const [relation] = await rows(`SELECT s.id FROM suppliers s JOIN portal_programme_suppliers ps ON ps.supplier_id=s.id JOIN programmes p ON p.id=ps.programme_id
    JOIN portal_supplier_relationships r ON r.buyer_id=p.buyer_id AND r.supplier_id=s.id AND r.status='active'
    WHERE ps.programme_id=$1 AND s.id=$2 AND s.archived_at IS NULL`, [programmeId, supplierId], db);
  requireCondition(relation, 422, 'Add this supplier to the programme before creating an invoice');
}
function serializeUser(record: Row) { const safe=Object.fromEntries(['id','email','role','buyer_id','created_at','updated_at',...userProfileColumns].filter(key=>record[key]!==undefined).map(key=>[key,record[key]]));return { ...safe, ...publicUser(record) }; }
function serializeBid(record: Row) { return { ...record,offered_financing_amount:record.amount,financier_id:record.financer_id,status:bidStatuses[record.status] }; }
function invoiceAccess(actor: Actor, invoice: Row, write = false) {
  if (actor.role === 'platform_ops') return;
  if (actor.role === 'buyer_admin' && same(actor.buyer_id, invoice.buyer_id)) return;
  if (!write && actor.role === 'supplier_user' && same(actor.id, invoice.supplier.user_id)) return;
  if (!write && actor.role === 'financer' && (invoice.has_own_bid || invoice.status === 'tender' && invoice.invited)) return;
  throw new ApiError(403, 'Forbidden');
}
async function invoiceFor(actor: Actor, invoiceId: string, buyerId: string | undefined, db: DB, write = false): Promise<Row> {
  const record = found((await rows(`${invoiceSelect} WHERE i.id=$1`, [invoiceId], db))[0]);
  const [visibility] = await rows(`SELECT EXISTS(SELECT 1 FROM bids WHERE invoice_id=$1 AND financer_id=$2) AS own,
    EXISTS(SELECT 1 FROM financing_tenders t JOIN portal_tender_invitations ti ON ti.tender_id=t.id WHERE t.invoice_id=$1 AND ti.financer_id=$2) AS invited`, [invoiceId, actor.id], db);
  record.has_own_bid = visibility.own; record.invited = visibility.invited;
  requireCondition(!record.deleted_at,404,'Invoice not found');
  if (buyerId) requireCondition(same(record.buyer_id, buyerId), 404, 'Not found');
  invoiceAccess(actor, record, write);
  delete record.has_own_bid; delete record.invited;
  return record;
}
function invoiceFilter(actor: Actor, values: unknown[]): string {
  if (actor.role === 'platform_ops') return 'TRUE';
  if (actor.role === 'buyer_admin') { values.push(actor.buyer_id); return `p.buyer_id=$${values.length}`; }
  values.push(actor.id);
  const user = `$${values.length}`;
  if (actor.role === 'supplier_user') return `s.user_id=${user}`;
  if (actor.role === 'financer') return financerVisible(user);
  return 'FALSE';
}
export async function invoiceList(actor: Actor, buyerId?: string, programmeId?: string, db: DB = pool(), includeDeleted=false) {
  const values: unknown[] = [];
  const where = [invoiceFilter(actor, values)];
  if(!includeDeleted)where.push('i.deleted_at IS NULL');
  if (buyerId) { await buyerFor(actor, buyerId, db); values.push(buyerId); where.push(`p.buyer_id=$${values.length}`); }
  if (programmeId) { await programmeFor(actor, programmeId, buyerId, db); values.push(programmeId); where.push(`i.programme_id=$${values.length}`); }
  return rows(`${invoiceSelect} WHERE ${where.join(' AND ')} ORDER BY i.id DESC`, values, db);
}
async function buyerJson(buyerId: string, db: DB) {
  const buyer = found((await rows('SELECT * FROM buyers WHERE id=$1', [buyerId], db))[0]);
  const users = await rows(`SELECT ${userColumns} FROM users WHERE buyer_id=$1 ORDER BY id`, [buyerId], db);
  return { ...buyer, users: users.map(serializeUser) };
}

/** One lock for every change to the operations administrator set; the count is rechecked after acquiring it. */
export async function lockOperatorSet(db: DB) { await rows('SELECT pg_advisory_xact_lock(72482904)', [], db); }
export async function requireOtherOperator(userId: string, db: DB) {
  await lockOperatorSet(db);
  const others = await rows('SELECT id FROM users WHERE role=2 AND disabled_at IS NULL AND id<>$1', [userId], db);
  requireCondition(others.length > 0, 409, 'Cannot remove the last platform operator');
}
async function saveUser(data: Input, actor: Actor, db: DB, userId?: string, buyerId?: string): Promise<Row> {
  if (userId && actor.role === 'platform_ops') await lockOperatorSet(db);
  const previous = userId ? found((await rows('SELECT * FROM users WHERE id=$1 FOR UPDATE', [userId], db))[0]) : undefined;
  const normalized: Input = { ...data, buyer_id: data.buyer_id === '' ? null : data.buyer_id };
  if (normalized.buyer_id === undefined && previous) normalized.buyer_id = previous.buyer_id;
  if (normalized.password === '') delete normalized.password;
  const parsed = (previous ? userInput.partial().extend({role:z.enum(roles).optional()}) : userInput).parse(normalized);
  if (parsed.password_confirmation !== undefined && parsed.password) requireCondition(parsed.password === parsed.password_confirmation, 422, 'Passwords do not match');
  const targetBuyer = buyerId ?? (parsed.buyer_id !== undefined ? parsed.buyer_id : previous?.buyer_id ?? null);
  // userInput defaults the role to supplier_user; a buyer member without an explicit role is a buyer administrator.
  const requested = normalized.role === undefined || normalized.role === '' ? undefined : parsed.role;
  const role = requested ?? (targetBuyer ? 'buyer_admin' : previous ? roles[previous.role] : parsed.role ?? 'supplier_user');
  if (actor.role !== 'platform_ops') {
    requireRole(actor, 'buyer_admin');
    ownBuyer(actor, buyerId);
    requireCondition(['buyer_admin', 'supplier_user'].includes(role), 403, 'Cannot assign a privileged role');
    if (previous) requireCondition(same(previous.buyer_id, buyerId) && previous.role !== 2 && previous.role !== 3, 403, 'Forbidden');
  }
  // A supplier account is linked through its supplier profile, never through a buyer membership.
  requireCondition(!targetBuyer || role === 'buyer_admin', 422, 'Members of a buyer organisation must be buyer administrators');
  if (targetBuyer) found((await rows('SELECT id FROM buyers WHERE id=$1', [targetBuyer], db))[0]);
  if (previous && same(previous.id, actor.id)) requireCondition(role === actor.role, 422, 'You cannot change your own role');
  // Protect the last operations account against lockout, including concurrent demotions (F07).
  if (previous?.role === 2 && role !== 'platform_ops') await requireOtherOperator(String(previous.id), db);
  const attrs: Input = { role: roles.indexOf(role), buyer_id: targetBuyer };
  if (parsed.email !== undefined) attrs.email = parsed.email;
  for(const key of ['name','job_title','contact_phone','country','preferred_language','timezone','recert_cycle'] as const)if(parsed[key]!==undefined)attrs[key]=parsed[key];
  if (parsed.password) attrs.encrypted_password = await hashPassword(parsed.password);
  if (!previous) {
    requireCondition(parsed.password, 422, 'Password is required');
    return insert('users', { ...attrs, jti: randomUUID() }, db);
  }
  if (parsed.password || parsed.email !== undefined && parsed.email !== previous.email || role !== roles[previous.role] || !same(targetBuyer, previous.buyer_id)) await revokeSessions(String(previous.id), db);
  return update('users', String(previous.id), attrs, db);
}

async function nestedUsers(body: Input, buyerId: string, actor: Actor, db: DB) {
  const raw = body.users_attributes ?? body.users;
  if (raw === undefined) return;
  const entries = z.array(z.record(z.string(), z.unknown())).max(100).parse(raw);
  for (const entry of entries) {
    const userId = entry.id ? parseId(entry.id) : undefined;
    if (userId) found((await rows('SELECT id FROM users WHERE id=$1 AND buyer_id=$2', [userId, buyerId], db))[0]);
    if (entry._destroy === true || entry._destroy === '1') {
      requireCondition(userId, 422, 'User ID is required');
      requireCondition(!same(userId, actor.id), 422, 'You cannot remove your own access');
      // Removing a buyer membership preserves historical records but disables the account: an account
      // without a tenant must never fall back to a broader scope (F01).
      await update('users', userId, { buyer_id: null, disabled_at: new Date() }, db);
      await revokeSessions(userId, db);
      await entityAudit(db,actor,'users',userId,'membership_removed',{buyer_id:buyerId},{buyer_id:null,disabled:true});
    } else await saveUser(entry, actor, db, userId, buyerId);
  }
}

async function buyers(actor: Actor, method: string, buyerId: string | undefined, body: Input): Promise<Result> {
  requireRole(actor, 'platform_ops', 'buyer_admin');
  return transaction(async db => {
    if (method === 'GET') {
      if (buyerId) { await buyerFor(actor, buyerId, db); return { data: await buyerJson(buyerId, db) }; }
      const list = actor.role === 'platform_ops' ? await rows('SELECT id FROM buyers ORDER BY id', [], db) : await rows('SELECT id FROM buyers WHERE id=$1', [actor.buyer_id], db);
      return { data: await Promise.all(list.map(buyer => buyerJson(String(buyer.id), db))) };
    }
    if (method === 'POST' && !buyerId) {
      requireRole(actor, 'platform_ops');
      throw new ApiError(403, 'Anchors are set up from their executed agreement in Organisation set-up');
      const input = payload(body, 'buyer');
      rejectManagedFields('buyers',input);
      const values=coreSchema('buyers').parse(input);
      const buyer = await insert('buyers', databaseValues('buyers',values), db);
      await entityAudit(db,actor,'buyers',String(buyer.id),'created',null,buyer);
      await nestedUsers(input, String(buyer.id), actor, db);
      return { data: await buyerJson(String(buyer.id), db), status: 201 };
    }
    requireCondition(buyerId, 405, 'Method not allowed');
    await buyerFor(actor, buyerId, db);
    if (method === 'PATCH' || method === 'PUT') {
      const input = payload(body, 'buyer');
      rejectManagedFields('buyers',input);
      await rows('SELECT id FROM buyers WHERE id=$1 FOR UPDATE',[buyerId],db);
      const previous=await buyerJson(buyerId,db);
      assertFresh(previous as Row);
      const buyer=await update('buyers', buyerId, databaseValues('buyers',coreSchema('buyers',true).parse(input)), db);
      await entityAudit(db,actor,'buyers',buyerId,'updated',previous,buyer);
      await nestedUsers(input, buyerId, actor, db);
      return { data: await buyerJson(buyerId, db) };
    }
    if (method === 'DELETE') {
      requireRole(actor, 'platform_ops');
      const dependencies = await rows('SELECT id FROM programmes WHERE buyer_id=$1 LIMIT 1', [buyerId], db);
      requireCondition(dependencies.length === 0, 409, 'Delete this buyer’s programmes before deleting the buyer');
      const members = await rows('SELECT id FROM users WHERE buyer_id=$1', [buyerId], db);
      const before = await buyerJson(buyerId, db);
      for (const member of members) await revokeSessions(String(member.id), db);
      await rows('UPDATE users SET buyer_id=NULL,disabled_at=coalesce(disabled_at,now()),updated_at=now() WHERE buyer_id=$1', [buyerId], db);
      await rows('DELETE FROM buyers WHERE id=$1', [buyerId], db);
      await entityAudit(db,actor,'buyers',buyerId,'deleted',before,null);
      return { status: 204 };
    }
    throw new ApiError(405, 'Method not allowed');
  });
}

async function programmes(actor: Actor, method: string, buyerId: string | undefined, programmeId: string | undefined, body: Input): Promise<Result> {
  return transaction(async db => {
    if(programmeId&&method!=='GET')await rows('SELECT id FROM programmes WHERE id=$1 FOR UPDATE',[programmeId],db);
    if (buyerId) await buyerFor(actor, buyerId, db);
    const previous = programmeId ? await programmeFor(actor, programmeId, buyerId, db) : undefined;
    if (method === 'GET') {
      if (previous) return { data: previous };
      requireRole(actor, 'platform_ops', 'buyer_admin');
      requireCondition(actor.role === 'platform_ops' || actor.buyer_id, 403, 'No buyer organization is assigned');
      return { data: await rows('SELECT * FROM programmes WHERE ($1::bigint IS NULL OR buyer_id=$1) ORDER BY id', [buyerId ?? (actor.role === 'buyer_admin' ? actor.buyer_id : null)], db) };
    }
    requireRole(actor, 'platform_ops');
    if (method === 'POST' && !programmeId) {
      const input = payload(body, 'programme');
      const target = buyerId ?? parseId(input.buyer_id);
      await buyerFor(actor, target, db);
      rejectManagedFields('programmes',input);
      const data=coreSchema('programmes').parse(input);
      await validateFieldReferences('programmes',data,actor,db);
      const record=await insert('programmes', {...databaseValues('programmes',data),buyer_id:target,status:'draft',created_by:actor.id,configured_by:actor.id},db);
      await entityAudit(db,actor,'programmes',String(record.id),'created',null,record);
      return {data:record,status:201};
    }
    requireCondition(programmeId && previous, 405, 'Method not allowed');
    if (method === 'PATCH' || method === 'PUT') {
      assertFresh(previous);
      requireCondition(!previous.archived_at&&(!previous.status||['draft','paused'].includes(previous.status)),409,'Pause the programme before editing released terms; submitted configurations are locked');
      const input=payload(body,'programme');rejectManagedFields('programmes',input);
      const data=coreSchema('programmes',true).parse(input);await validateFieldReferences('programmes',data,actor,db);
      requireCondition(!(await rows("SELECT id FROM invoices WHERE programme_id=$1 AND status IN ('tender','funded','repaid') LIMIT 1",[programmeId],db)).length,409,'Economic programme terms are locked while financing obligations are active');
      const record=await update('programmes',programmeId,{...databaseValues('programmes',data),configured_by:actor.id},db);
      await entityAudit(db,actor,'programmes',programmeId,'updated',previous,record);return {data:record};
    }
    if (method === 'DELETE') {
      requireCondition(!previous.archived_at&&(!previous.status||previous.status==='draft'),409,'Archive released programmes to preserve their history');
      requireCondition(!(await rows('SELECT id FROM invoices WHERE programme_id=$1 LIMIT 1', [programmeId], db)).length, 409, 'Delete this programme’s invoices first');
      await rows('DELETE FROM portal_programme_suppliers WHERE programme_id=$1', [programmeId], db);
      await rows('DELETE FROM portal_programme_financiers WHERE programme_id=$1', [programmeId], db);
      await rows('DELETE FROM programmes WHERE id=$1', [programmeId], db);
      await entityAudit(db,actor,'programmes',programmeId,'deleted',previous,null);
      return { status: 204 };
    }
    throw new ApiError(405, 'Method not allowed');
  });
}

async function invoices(actor: Actor, method: string, buyerId: string | undefined, programmeId: string | undefined, invoiceId: string | undefined, body: Input): Promise<Result> {
  return transaction(async db => {
    if (method === 'GET') return { data: invoiceId ? await invoiceFor(actor, invoiceId, buyerId, db) : await invoiceList(actor, buyerId, programmeId, db) };
    requireRole(actor, 'platform_ops', 'buyer_admin');
    if (method === 'POST' && !invoiceId) {
      const input = payload(body, 'invoice');
      rejectManagedFields('invoices',input);
      const data = coreSchema('invoices').parse({ ...input, programme_id: programmeId ?? input.programme_id });
      validateInvoiceFields(data);
      await validateFieldReferences('invoices',data,actor,db);
      await programmeFor(actor, data.programme_id, buyerId, db);
      await requireProgrammeSupplier(data.programme_id, data.supplier_id, db);
      // Status is server-controlled: approval and tender come only from the supplier approval and tender workflows (F04).
      requireCondition(data.status === 'draft', 409, 'New invoices start as drafts. Use the submission and tender workflow to change their status.');
      const invoice = await insert('invoices', databaseValues('invoices',data), db);
      await entityAudit(db,actor,'invoices',String(invoice.id),'created',null,invoice);
      return { data: await invoiceFor(actor, String(invoice.id), buyerId, db), status: 201 };
    }
    requireCondition(invoiceId, 405, 'Method not allowed');
    await rows('SELECT id FROM invoices WHERE id=$1 FOR UPDATE', [invoiceId], db);
    const previous = await invoiceFor(actor, invoiceId, buyerId, db, true);
    requireCondition(!previous.financial_review_required,409,'Legacy financial evidence requires reconciliation before invoice edits');
    if (method === 'DELETE') {
      requireCondition(!['funded', 'repaid'].includes(previous.status), 409, 'Funded invoices cannot be deleted');
      requireCondition(!(await rows('SELECT id FROM bids WHERE invoice_id=$1 AND status=1',[invoiceId],db)).length,409,'An accepted offer cannot be deleted');
      requireCondition(!['pending','approved'].includes(previous.invoice_approval_status),409,'Withdraw the submission before deleting this invoice');
      requireCondition(!(await rows('SELECT id FROM bids WHERE invoice_id=$1 LIMIT 1',[invoiceId],db)).length,409,'Invoices with offer history cannot be deleted');
      await rows('UPDATE invoices SET deleted_at=now(),updated_at=now() WHERE id=$1', [invoiceId], db);
      await entityAudit(db,actor,'invoices',invoiceId,'deleted',previous,null);
      return { status: 204 };
    }
    if (method === 'PATCH' || method === 'PUT') {
      assertFresh(previous);
      requireCondition(!['pending','approved'].includes(previous.invoice_approval_status),409,'Withdraw the submission or approval before changing invoice terms');
      const input=payload(body,'invoice');rejectManagedFields('invoices',input);
      const data=coreSchema('invoices',true).parse(input);
      validateInvoiceFields({...previous,...data});await validateFieldReferences('invoices',data,actor,db);
      // Compatibility routes edit terms only. Every status change goes through the domain workflow, which
      // enforces supplier approval, tender publication and invitations (F04).
      if (input.status !== undefined) requireCondition(data.status === previous.status, 409, 'Invoice status changes use the submission, approval and tender workflow');
      delete (data as Row).status;
      if (['funded', 'repaid', 'tender', 'cancelled'].includes(previous.status)) requireCondition(Object.keys(data).length === 0, 409, 'Invoice details are locked in its current status');
      const hasBids = (await rows('SELECT id FROM bids WHERE invoice_id=$1 LIMIT 1', [invoiceId], db)).length > 0;
      if (hasBids) requireCondition(Object.keys(data).length === 0, 409, 'Invoice terms cannot change after bidding starts');
      await programmeFor(actor, data.programme_id ?? String(previous.programme_id), buyerId, db);
      if (data.supplier_id || data.programme_id) await requireProgrammeSupplier(data.programme_id ?? String(previous.programme_id), data.supplier_id ?? String(previous.supplier_id), db);
      const record=await update('invoices', invoiceId, databaseValues('invoices',data), db);
      await entityAudit(db,actor,'invoices',invoiceId,'updated',previous,record);
      return { data: await invoiceFor(actor, invoiceId, buyerId, db) };
    }
    throw new ApiError(405, 'Method not allowed');
  });
}

function bidRead(actor: Actor, bid: Row) {
  requireCondition(actor.role === 'platform_ops' || actor.role === 'buyer_admin' && same(actor.buyer_id, bid.buyer_id)
    || actor.role === 'financer' && same(actor.id, bid.financer_id) || actor.role === 'supplier_user' && same(actor.id, bid.supplier_user_id), 403, 'Forbidden');
}
async function bids(actor: Actor, method: string, invoiceId: string | undefined, bidId: string | undefined, action: string | undefined, buyerId: string | undefined, financerId: string | undefined, body: Input): Promise<Result> {
  if (action) {
    requireCondition(bidId && ['accept','reject'].includes(action), 404, 'Not found');
    requireCondition(['PATCH','PUT'].includes(method), 405, 'Method not allowed');
  }
  return transaction(async db => {
    if (invoiceId && method === 'GET') await invoiceFor(actor, invoiceId, buyerId, db);
    if (financerId) requireCondition(actor.role === 'platform_ops' || actor.role === 'financer' && same(actor.id, financerId), 403, 'Forbidden');
    if (method === 'GET') {
      const values: unknown[] = [];
      const where: string[] = [];
      if (actor.role === 'buyer_admin') { values.push(actor.buyer_id); where.push(`p.buyer_id=$${values.length}`); }
      if (actor.role === 'financer') { values.push(actor.id); where.push(`d.financer_id=$${values.length}`); }
      if (actor.role === 'supplier_user') { values.push(actor.id); where.push(`s.user_id=$${values.length}`); }
      if (invoiceId) { values.push(invoiceId); where.push(`d.invoice_id=$${values.length}`); }
      if (bidId) { values.push(bidId); where.push(`d.id=$${values.length}`); }
      if (financerId) { values.push(financerId); where.push(`d.financer_id=$${values.length}`); }
      const list = await rows(`${bidSelect} ${where.length ? 'WHERE '+where.join(' AND ') : ''} ORDER BY d.id DESC`, values, db);
      const output = list.filter(bid=>actor.role==='financer'||bid.portal_state!=='DRAFT').map(serializeBid);
      return { data: bidId ? found(output[0]) : output };
    }
    if (method === 'POST' && !bidId) {
      requireRole(actor, 'financer');
      const input = payload(body, 'bid');
      const target = invoiceId ?? parseId(input.invoice_id);
      await rows('SELECT id FROM invoices WHERE id=$1 FOR UPDATE', [target], db);
      const invoice = await invoiceFor(actor, target, buyerId, db);
      requireCondition(invoice.status === 'tender', 409, 'Invoice is not open for bids');
      requireCondition(invoice.currency,409,'Invoice currency must be recorded before bidding');
      requireCondition(!invoice.financial_review_required,409,'Legacy invoice requires review');
      requireCondition(!(await rows('SELECT id FROM bids WHERE invoice_id=$1 AND status=1',[target],db)).length,409,'An offer has already been selected');
      rejectManagedFields('bids',input);
      // Financing needs a published, open tender to which this financier is invited (F04).
      const [openTender]=await rows('SELECT * FROM financing_tenders WHERE invoice_id=$1 ORDER BY id DESC LIMIT 1',[target],db);
      requireCondition(openTender&&openTender.status==='open'&&new Date(openTender.closes_at).getTime()>Date.now(),409,'Tender is closed');
      requireCondition((await rows('SELECT 1 FROM portal_tender_invitations WHERE tender_id=$1 AND financer_id=$2',[openTender.id,actor.id],db)).length,403,'This tender is invitation only');
      const data = coreSchema('bids').parse(input);
      const priced=priceBid(data,invoice);
      validateBid({...priced,amount:String(priced.amount),expiry_date:priced.expiry_date as string|null}, invoice);
      requireCondition(!(await rows('SELECT id FROM bids WHERE invoice_id=$1 AND financer_id=$2 AND status IN (0,1)', [target, actor.id], db)).length, 409, 'You already have an active bid on this invoice');
      const bid = await insert('bids', { ...databaseValues('bids',priced), invoice_id: target, financer_id: actor.id, status: 0 }, db);
      await audit(db,actor,String(target),'bid.submitted','bid',String(bid.id),{after:bid});
      return { data: serializeBid(bid), status: 201 };
    }
    requireCondition(bidId, 405, 'Method not allowed');
    const initial = found((await rows('SELECT invoice_id FROM bids WHERE id=$1', [bidId], db))[0]);
    if (invoiceId) requireCondition(same(invoiceId, initial.invoice_id), 404, 'Not found');
    // Always lock the invoice first: competing accept/create/update requests serialize on the same row.
    await rows('SELECT id FROM invoices WHERE id=$1 FOR UPDATE', [initial.invoice_id], db);
    const bid = found((await rows(`${bidSelect} WHERE d.id=$1 FOR UPDATE OF d`, [bidId], db))[0]);
    if (buyerId) requireCondition(same(bid.buyer_id, buyerId), 404, 'Not found');
    bidRead(actor, bid);
    requireCondition(bid.status === 0 && bid.invoice_status === 'tender', 409, 'Only pending bids on tendered invoices can change');
    if (action) {
      requireCondition(method === 'PATCH' || method === 'PUT', 405, 'Method not allowed');
      ownBuyer(actor, bid.buyer_id);
      requireCondition(action === 'accept' || action === 'reject', 404, 'Not found');
      // The person deciding for the buyer must not be the one who priced the offer for the financier.
      const decider = actor.delegation?.admin_id ?? actor.id;
      requireCondition(!await preparedOnBehalfBy(decider, 'bids', bidId, db) && !(await rows("SELECT 1 FROM portal_events WHERE actor_id=$1 AND event LIKE 'bid.%' AND details->>'bid_id'=$2 UNION ALL SELECT 1 FROM audit_events WHERE actor_id=$1 AND record_type='bid' AND record_id::text=$2 AND event<>'bid.rejected' LIMIT 1", [decider, bidId], db)).length, 403, 'You prepared this offer on behalf of the financier; the buyer or a different administrator must decide on it');
      if (action === 'accept') {
        requireCondition(bid.portal_state!=='DRAFT'&&bid.portal_state!=='WITHDRAWN',409,'Only submitted offers can be accepted');
        assertFinancialRelease();
        requireCondition(!(await rows('SELECT id FROM invoices WHERE id=$1 AND financial_review_required',[bid.invoice_id],db)).length,409,'Legacy invoice requires review');
        requireCondition(!bid.expiry_date || String(bid.expiry_date).slice(0, 10) >= new Date().toISOString().slice(0, 10), 409, 'Bid has expired');
        requireCondition(!bid.expires_at||Date.parse(bid.expires_at)>Date.now(),409,'Bid has expired');
        requireCondition((await rows("SELECT 1 FROM financing_tenders t JOIN portal_tender_invitations ti ON ti.tender_id=t.id WHERE t.invoice_id=$1 AND t.status='open' AND ti.financer_id=$2",[bid.invoice_id,bid.financer_id],db)).length,409,'Only offers from invited financiers on an open tender can be accepted');
        await update('bids', bidId, { status: 1 }, db);
        await rows("UPDATE financing_tenders SET status='awarded',accepted_bid_id=$2 WHERE invoice_id=$1 AND status='open'",[bid.invoice_id,bidId],db);
        await rows('UPDATE bids SET status=2,updated_at=now() WHERE invoice_id=$1 AND id<>$2 AND status=0', [bid.invoice_id, bidId], db);
        await audit(db,actor,String(bid.invoice_id),'bid.accepted','bid',bidId,{before:{status:'pending'},after:{status:'accepted'},invoice_status:'tender',competing_pending_offers:'rejected'});
      } else {
        await update('bids', bidId, { status: 2 }, db);
        await audit(db,actor,String(bid.invoice_id),'bid.rejected','bid',bidId,{before:{status:'pending'},after:{status:'rejected'}});
      }
      return { data: serializeBid(found((await rows(`${bidSelect} WHERE d.id=$1`, [bidId], db))[0])) };
    }
    requireCondition(actor.role === 'platform_ops' || actor.role === 'financer' && same(actor.id, bid.financer_id), 403, 'Forbidden');
    if (method === 'DELETE') {
      // Only unsubmitted drafts are erased; a submitted offer is withdrawn so its history remains (F19).
      if (bid.portal_state === 'DRAFT') await rows('DELETE FROM bids WHERE id=$1', [bidId], db);
      else await rows("UPDATE bids SET status=2,portal_state='WITHDRAWN',updated_at=now() WHERE id=$1", [bidId], db);
      await audit(db,actor,String(bid.invoice_id),bid.portal_state === 'DRAFT' ? 'bid.draft_deleted' : 'bid.withdrawn','bid',bidId,{before:bid});
      return { status: 204 };
    }
    if (method === 'PATCH' || method === 'PUT') {
      assertFresh(bid);
      const input=payload(body,'bid');rejectManagedFields('bids',input);
      const data=coreSchema('bids',true).parse(input);
      const invoice=await invoiceFor(actor,String(bid.invoice_id),buyerId,db);
      const priced=priceBid({...bid,...data},invoice);
      validateBid({amount:String(priced.amount),expiry_date:priced.expiry_date},invoice);
      const writable=Object.fromEntries(fieldCatalog.bids.fields.filter(field=>!field.readOnly&&!field.transient).filter(field=>priced[field.key]!==undefined).map(field=>[field.key,priced[field.key]]));
      const values={...writable,requested_financing_amount:priced.requested_financing_amount,net_supplier_proceeds:priced.net_supplier_proceeds,pricing_snapshot:priced.pricing_snapshot};
      const updated=await update('bids',bidId,databaseValues('bids',values),db);
      await audit(db,actor,String(bid.invoice_id),'bid.updated','bid',bidId,{before:bid,after:updated});
      return {data:serializeBid(updated)};
    }
    throw new ApiError(405, 'Method not allowed');
  });
}
function validateBid(data: { amount: string; expiry_date?: string | null }, invoice: Row) {
  requireCondition(cents(data.amount) <= cents(invoice.amount), 422, 'Bid cannot exceed the invoice amount');
  requireCondition(!data.expiry_date || data.expiry_date >= new Date().toISOString().slice(0, 10), 422, 'Expiry date must be today or later');
}

function validateInvoiceFields(data:Row){
  requireCondition(!data.issue_date||!data.due_date||data.due_date>=data.issue_date,422,'Due date must not precede issue date');
  requireCondition(!data.financing_amount_requested||cents(data.financing_amount_requested)<=cents(data.amount),422,'Requested financing exceeds invoice face value');
}
export function priceBid(data:Row,invoice:Row):Row{
  requireCondition(data.currency===invoice.currency,422,'Bid currency must match the invoice');
  requireCondition(invoice.financing_eligible===true,409,'Invoice is not marked eligible for financing');
  requireCondition(invoice.due_date,422,'Invoice maturity is required to price a bid');
  const today=new Date().toISOString().slice(0,10);
  requireCondition(invoice.due_date>=today,422,'Matured invoices cannot receive financing offers');
  requireCondition(!invoice.financing_amount_requested||cents(String(data.amount))<=cents(invoice.financing_amount_requested),422,'Offer exceeds the requested financing amount');
  const days=Math.max(0,Math.ceil((Date.parse(invoice.due_date+'T00:00:00Z')-Date.parse(today+'T00:00:00Z'))/86400000));
  const quote=discountQuote({amount:String(data.amount),model:data.discount_type,rate:data.discount_rate??'0',days,basis:String(data.day_count_basis)==='360'?360:365,fixed_fee:data.discount_fee??'0',other_fees:data.other_fees??'0'});
  requireCondition(!data.expires_at||Date.parse(data.expires_at)>Date.now(),422,'Bid expiry must be in the future');
  requireCondition(!data.proposed_disbursement_date||String(data.proposed_disbursement_date)>=today&&String(data.proposed_disbursement_date)<=invoice.due_date,422,'Proposed disbursement date must be between today and the invoice due date');
  return {...data,requested_financing_amount:invoice.financing_amount_requested??invoice.amount,discount_fee:quote.discount_amount,net_supplier_proceeds:quote.net_supplier_proceeds,submitted_at:data.submitted_at??new Date().toISOString(),pricing_snapshot:{...quote,currency:data.currency,model:data.discount_type,rate:data.discount_rate??'0',days,day_count_basis:data.day_count_basis,calculated_at:new Date().toISOString()}};
}
async function financierJson(user:Row,db:DB){
  const profile=(await rows('SELECT * FROM financier_profiles WHERE user_id=$1',[user.id],db))[0]??{};
  const {id:profileId,user_id:_userId,...fields}=profile;
  return {...serializeUser(user),...fields,id:String(user.id),profile_id:profileId??null};
}
async function saveFinancierProfile(userId:string,data:Row,db:DB){
  const keys=Object.keys(data);if(!keys.length)return;
  const columns=keys.map(key=>'"'+key+'"');
  await rows(`INSERT INTO financier_profiles(user_id,${columns.join(',')}) VALUES($1,${keys.map((_,index)=>'$'+(index+2)).join(',')}) ON CONFLICT(user_id) DO UPDATE SET ${keys.map(key=>'"'+key+'"=EXCLUDED."'+key+'"').join(',')},updated_at=now()`,[userId,...Object.values(data)],db);
}

async function users(actor: Actor, method: string, userId: string | undefined, body: Input, financerOnly = false): Promise<Result> {
  return transaction(async db => {
    if (method === 'GET') {
      if (!userId) { requireRole(actor, 'platform_ops'); const list=await rows(`SELECT ${userColumns} FROM users ${financerOnly ? 'WHERE role=3' : ''} ORDER BY id`, [], db);return {data:financerOnly?await Promise.all(list.map(user=>financierJson(user,db))):list.map(serializeUser)}; }
      requireCondition(actor.role === 'platform_ops' || same(actor.id, userId), 403, 'Forbidden');
      const user = found((await rows(`SELECT ${userColumns} FROM users WHERE id=$1 ${financerOnly ? 'AND role=3' : ''}`, [userId], db))[0]);
      return { data: financerOnly?await financierJson(user,db):serializeUser(user) };
    }
    requireRole(actor, 'platform_ops');
    const input = payload(body, financerOnly ? 'financer' : 'user');
    if (financerOnly) input.role = 'financer';
    if(!financerOnly)rejectManagedFields('users',input);
    if (method === 'POST' && !userId) {
      requireCondition(!financerOnly, 403, 'Funders are set up from their executed agreement in Organisation set-up');
      const profile=financerOnly?fieldSchema('financers',false,{exclude:['email']}).parse(input):null;
      const user=await saveUser(input,actor,db);
      if(profile){await validateFieldReferences('financers',profile,actor,db);await saveFinancierProfile(String(user.id),profile,db);await entityAudit(db,actor,'financers',String(user.id),'created',null,profile);}
      return {data:financerOnly?await financierJson(user,db):serializeUser(user),status:201};
    }
    requireCondition(userId, 405, 'Method not allowed');
    // Take the administrator-set lock before any row lock so concurrent role changes cannot deadlock or race.
    await lockOperatorSet(db);
    const previous = found((await rows(`SELECT * FROM users WHERE id=$1 ${financerOnly ? 'AND role=3' : ''} FOR UPDATE`, [userId], db))[0]);
    if (method === 'PATCH' || method === 'PUT') {
      assertFresh(previous);
      if(financerOnly)rejectManagedFields('financers',input);
      const profile=financerOnly?fieldSchema('financers',true,{exclude:['email']}).parse(input):null;
      const user=await saveUser(input,actor,db,userId);
      if(profile){await validateFieldReferences('financers',profile,actor,db);const previousProfile=(await rows('SELECT * FROM financier_profiles WHERE user_id=$1',[userId],db))[0]??null;await saveFinancierProfile(userId,profile,db);await entityAudit(db,actor,'financers',userId,'updated',previousProfile,profile);}
      return {data:financerOnly?await financierJson(user,db):serializeUser(user)};
    }
    if (method === 'DELETE') {
      requireCondition(!same(actor.id, userId), 422, 'You cannot delete your own account');
      if (previous.role === 2) await requireOtherOperator(userId, db);
      requireCondition(!(await rows('SELECT id FROM bids WHERE financer_id=$1 UNION ALL SELECT id FROM suppliers WHERE user_id=$1 LIMIT 1', [userId], db)).length, 409, 'Account has financial records and cannot be deleted');
      await rows('DELETE FROM portal_mfa_challenges WHERE user_id=$1',[userId],db);
      await rows('DELETE FROM app_sessions WHERE user_id=$1',[userId],db);
      await rows('DELETE FROM financier_profiles WHERE user_id=$1',[userId],db);
      await rows('DELETE FROM users WHERE id=$1', [userId], db);
      await entityAudit(db,actor,financerOnly?'financers':'users',userId,'deleted',serializeUser(previous),null);
      return { status: 204 };
    }
    throw new ApiError(405, 'Method not allowed');
  });
}

async function suppliers(actor: Actor, method: string, supplierId: string | undefined, body: Input, resend = false): Promise<Result> {
  if (resend) requireCondition(supplierId && method === 'POST',405,'Method not allowed');
  let invitation: { email: string; token: string } | undefined;
  const result = await transaction(async db => {
    if (method === 'GET') {
      const values: unknown[] = [];
      const where: string[] = [];
      // Profiles are scoped to the supplier's own account, the buyer's active relationships, or invoices a
      // financier may see; counterparties get a reduced column set (F03).
      let columns = supplierColumns;
      if (actor.role === 'supplier_user') { values.push(actor.id); where.push(`user_id=$${values.length}`); }
      else if (actor.role === 'buyer_admin') {
        requireCondition(actor.buyer_id, 403, 'Your account is not linked to an active organisation');
        values.push(actor.buyer_id);
        where.push(`id IN (SELECT r.supplier_id FROM portal_supplier_relationships r WHERE r.buyer_id=$${values.length} AND r.status='active')`);
        columns = supplierPartnerColumns;
      } else if (actor.role === 'financer') {
        values.push(actor.id);
        where.push(`id IN (SELECT i.supplier_id FROM invoices i WHERE ${financerVisible(`$${values.length}`)})`);
        columns = supplierPublicColumns;
      } else if (actor.role !== 'platform_ops') where.push('FALSE');
      if (supplierId) { values.push(supplierId); where.push(`id=$${values.length}`); }
      const list = await rows(`SELECT ${columns} FROM suppliers ${where.length ? 'WHERE '+where.join(' AND ') : ''} ORDER BY id`, values, db);
      return { data: supplierId ? found(list[0]) : list };
    }
    requireRole(actor, 'platform_ops');
    const raw = payload(body, 'supplier');
    const schema = z.object({ name: z.string().trim().min(1).max(200), contact_email: email, company: z.string().max(200).nullable().optional(),
      invite: z.enum(['create','invite']).default('create'), password: password.optional(), password_confirmation: z.string().optional() });
    if (method === 'POST' && !supplierId) {
      rejectManagedFields('suppliers',raw);
      const institution=fieldSchema('suppliers').parse({...raw,contact_email:raw.contact_email??raw.email});
      const data = schema.parse({ ...raw, contact_email: raw.contact_email ?? raw.email,
        password:raw.password === '' ? undefined : raw.password,
        password_confirmation:raw.password_confirmation === '' ? undefined : raw.password_confirmation });
      const existing = (await rows('SELECT * FROM users WHERE email=$1 FOR UPDATE', [data.contact_email], db))[0];
      requireCondition(!existing || existing.role === 1, 409, 'Email belongs to a different account role');
      requireCondition(!existing || !(await rows('SELECT id FROM suppliers WHERE user_id=$1', [existing.id], db)).length, 409, 'Account already has a supplier profile');
      if (data.invite === 'invite') { await requireMailConfiguration(); appUrl(); }
      if (!existing && data.invite === 'create') {
        requireCondition(data.password, 422, 'Password is required');
        requireCondition(!data.password_confirmation || data.password === data.password_confirmation, 422, 'Passwords do not match');
      }
      const user = existing ?? await insert('users', { email: data.contact_email, encrypted_password: data.invite === 'invite' ? '' : await hashPassword(data.password!), role: 1, jti: randomUUID() }, db);
      const token = data.invite === 'invite' ? newToken() : undefined;
      const supplier = await insert('suppliers', { ...databaseValues('suppliers',Object.fromEntries(Object.entries(institution).filter(([key])=>key!=='contact_email'))), name: data.name, email: data.contact_email, company: data.company ?? null, user_id: user.id,
        invitation_token: token ? digest(token) : null, invited_at: token ? new Date() : null, invitation_expires_at: token ? new Date(Date.now()+7*86400000) : null }, db);
      await entityAudit(db,actor,'suppliers',String(supplier.id),'created',null,supplier);
      if (token) invitation = { email: data.contact_email, token };
      const { invitation_token: _token, invitation_expires_at: _expiry, ...safe } = supplier;
      return { data: { ...safe, contact_email: supplier.email }, status: 201 };
    }
    requireCondition(supplierId, 405, 'Method not allowed');
    const previous = found((await rows('SELECT * FROM suppliers WHERE id=$1 FOR UPDATE', [supplierId], db))[0]);
    if (resend) {
      await requireMailConfiguration(); appUrl();
      const token=newToken();
      await update('suppliers',supplierId,{invitation_token:digest(token),invited_at:new Date(),invitation_expires_at:new Date(Date.now()+7*86400000)},db);
      invitation={email:previous.email,token};
      return {data:(await rows(`SELECT ${supplierColumns} FROM suppliers WHERE id=$1`,[supplierId],db))[0]};
    }
    if (method === 'PATCH' || method === 'PUT') {
      assertFresh(previous);
      rejectManagedFields('suppliers',raw);
      const data=fieldSchema('suppliers',true).parse({...raw,contact_email:raw.contact_email??raw.email});
      const { contact_email, ...attrs } = data;
      if (contact_email && previous.user_id) {
        await update('users', String(previous.user_id), { email: contact_email }, db);
        await revokeSessions(String(previous.user_id), db);
      }
      const record=await update('suppliers', supplierId, { ...databaseValues('suppliers',attrs), ...(contact_email ? {email:contact_email} : {}) }, db);
      await entityAudit(db,actor,'suppliers',supplierId,'updated',previous,record);
      return { data: (await rows(`SELECT ${supplierColumns} FROM suppliers WHERE id=$1`, [supplierId], db))[0] };
    }
    if (method === 'DELETE') {
      requireCondition(!(await rows('SELECT id FROM invoices WHERE supplier_id=$1 LIMIT 1', [supplierId], db)).length, 409, 'Supplier has invoices and cannot be deleted');
      await rows('DELETE FROM portal_programme_suppliers WHERE supplier_id=$1', [supplierId], db);
      await rows('DELETE FROM portal_supplier_relationships WHERE supplier_id=$1', [supplierId], db);
      await rows('DELETE FROM suppliers WHERE id=$1', [supplierId], db);
      await entityAudit(db,actor,'suppliers',supplierId,'deleted',previous,null);
      return { status: 204 };
    }
    throw new ApiError(405, 'Method not allowed');
  });
  if (invitation) {
    // The persisted invite remains available for retry if delivery fails.
    try {
      const mail = await sendLink(invitation.email, 'Accept your Invoix supplier invitation', `${appUrl()}/supplier-signup/${invitation.token}`);
      result.data = { ...result.data, ...mail, delivery_status:'sent' };
    } catch {
      result.data = { ...result.data, delivery_status:'failed', warning:'Supplier saved, but the email could not be delivered. Retry the invitation from the supplier edit screen.' };
    }
  }
  return result;
}

async function financerData(actor: Actor, financerId: string, action: string): Promise<Result> {
  requireCondition(actor.role === 'platform_ops' || actor.role === 'financer' && same(actor.id, financerId), 403, 'Forbidden');
  found((await rows('SELECT id FROM users WHERE id=$1 AND role=3', [financerId]))[0]);
  if (action === 'bids') return bids(actor, 'GET', undefined, undefined, undefined, undefined, financerId, {});
  // Opportunities are open tenders this financier is invited to; the same visibility rule as every invoice read (F02).
  if (action === 'opportunities') return { data: await rows(`${invoiceSelect} WHERE i.status='tender' AND i.deleted_at IS NULL AND i.financing_eligible=true AND i.currency IS NOT NULL AND NOT i.financial_review_required
    AND EXISTS(SELECT 1 FROM financing_tenders t JOIN portal_tender_invitations ti ON ti.tender_id=t.id WHERE t.invoice_id=i.id AND t.status='open' AND t.closes_at>now() AND ti.financer_id=$1)
    AND NOT EXISTS(SELECT 1 FROM bids d WHERE d.invoice_id=i.id AND (d.status=1 OR d.financer_id=$1 AND d.status=0)) ORDER BY i.id DESC`, [financerId]) };
  if (action === 'portfolio') return { data: await rows(`${invoiceSelect} WHERE EXISTS(SELECT 1 FROM bids d JOIN fundings f ON f.invoice_id=d.invoice_id WHERE d.invoice_id=i.id AND d.financer_id=$1 AND d.status=1 AND f.status='completed') ORDER BY i.id DESC`, [financerId]) };
  throw new ApiError(404, 'Not found');
}

/** One dispatcher backs the app API and the /api/v1 compatibility URLs. */
export async function resourceRequest(actor: Actor, method: string, path: string[], body: Input = {}): Promise<Result> {
  const [resource, rawId, child, rawChildId, grandchild, rawGrandchildId, action] = path;
  const recordId = rawId ? parseId(rawId) : undefined;
  if (resource === 'buyers') {
    if (!child && path.length <= 2) return buyers(actor, method, recordId, body);
    requireCondition(recordId, 404, 'Not found');
    if (child === 'programmes' && path.length <= 4) return programmes(actor, method, recordId, rawChildId ? parseId(rawChildId) : undefined, body);
    if (child === 'invoices') {
      const invoiceId = rawChildId ? parseId(rawChildId) : undefined;
      if (!grandchild && path.length <= 4) return invoices(actor, method, recordId, undefined, invoiceId, body);
      if (grandchild === 'bids' && invoiceId && path.length <= 7) return bids(actor, method, invoiceId, rawGrandchildId ? parseId(rawGrandchildId) : undefined, action, recordId, undefined, body);
    }
  }
  if (resource === 'programmes') {
    if (!child && path.length <= 2) return programmes(actor, method, undefined, recordId, body);
    if (child === 'invoices' && recordId && path.length === 3) return invoices(actor, method, undefined, recordId, undefined, body);
  }
  if (resource === 'invoices') {
    if (!child && path.length <= 2) return invoices(actor, method, undefined, undefined, recordId, body);
    if(child==='bid-quote'&&recordId&&path.length===3&&method==='POST'){
      requireRole(actor,'financer');
      return transaction(async db=>{const invoice=await invoiceFor(actor,recordId,undefined,db);requireCondition(invoice.status==='tender'&&!invoice.financial_review_required,409,'Invoice is not available for pricing');const input=payload(body,'bid');rejectManagedFields('bids',input);const quote=priceBid(coreSchema('bids').parse(input),invoice);validateBid({amount:String(quote.amount),expiry_date:quote.expiry_date},invoice);return {data:quote};});
    }
    if (child === 'bids' && recordId && path.length <= 5) return bids(actor, method, recordId, rawChildId ? parseId(rawChildId) : undefined, grandchild, undefined, undefined, body);
  }
  if (resource === 'bids' && path.length <= 3) {
    if (child) requireCondition(recordId && ['accept','reject'].includes(child) && ['PATCH','PUT'].includes(method), 405, 'Method not allowed');
    return bids(actor, method, undefined, recordId, child, undefined, undefined, body);
  }
  if (resource === 'users' && path.length <= 2) return users(actor, method, recordId, body);
  if (resource === 'suppliers' && path.length <= 2) return suppliers(actor, method, recordId, body);
  if (resource === 'suppliers' && recordId && child === 'invite' && path.length === 3) return suppliers(actor, method, recordId, body, true);
  if (resource === 'financers') {
    if (!child && path.length <= 2) return users(actor, method, recordId, body, true);
    if (recordId && child && method === 'GET' && path.length === 3) return financerData(actor, recordId, child);
  }
  throw new ApiError(404, 'Not found');
}
