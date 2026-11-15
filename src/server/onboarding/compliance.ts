import { z } from 'zod';
import { type Actor } from '../auth';
import { rows, transaction, type DB, type Row } from '../db';
import { ApiError, requireCondition } from '../errors';
import { id, date } from '../validation';
import { portalEvent, notify, orgRef } from '../portal-support';
import { type Counterparty, EDITABLE_SETUP, lifecycle, transition } from './lifecycle';
import { hasOpsRole, requireOpsRole } from './roles';
import { provisioningProblems, requiredContacts } from './setup';

/**
 * SRS increment 2 — the compliance gate (A2 anchor, F1.3/F1.7–F1.8 funder, S2 supplier). The platform is the system
 * of record for compliance: the checklist comes from configuration, documents carry issue and expiry dates, beneficial
 * ownership is structured and must resolve to natural persons, every party is screened (provider-agnostic; recorded
 * manually until a provider is connected), bank accounts are verified by a second person with a cool-off, and a
 * compliance officer who did not submit the file signs it off, refers it back with itemised gaps, or declines it.
 * Anchors and funders have no access during this stage; suppliers complete their own file (S2).
 */
const same = (a: unknown, b: unknown) => String(a) === String(b);
const text = (max: number) => z.string().trim().max(max);
const today = () => new Date().toISOString().slice(0, 10);
const refPattern = /^(buyer|financier|supplier)-[1-9]\d{0,17}$/;
const SUPPLIER_EDITABLE = ['REGISTERED', 'INFO_REQUIRED'];
const ACCOUNT_PURPOSE: Record<Counterparty, string> = { ANCHOR: 'settlement', FUNDER: 'settlement', SUPPLIER: 'payout' };
const ACCOUNT_LABEL: Record<Counterparty, string> = { ANCHOR: 'the account the anchor settles maturing invoices from', FUNDER: 'the funding and repayment account', SUPPLIER: 'the bank account to be paid into' };

async function setting<T>(key: string, db?: DB): Promise<T> {
  const [row] = await rows('SELECT value FROM onboarding_settings WHERE key=$1', [key], db);
  return row?.value as T;
}
type File = { ref: string; counterparty: Counterparty; key: string; record: Row; state: NonNullable<Awaited<ReturnType<typeof lifecycle>>> };
async function load(ref: string, db: DB, lock = false): Promise<File> {
  requireCondition(refPattern.test(ref), 404, 'Organisation not found');
  const state = await lifecycle(ref, db, lock);
  requireCondition(state && !state.legacy, 404, 'This organisation has no compliance file on the platform');
  const [kind, key] = ref.split('-');
  const table = kind === 'buyer' ? 'buyers' : kind === 'supplier' ? 'suppliers' : 'financier_profiles';
  const [record] = await rows(`SELECT * FROM ${table} WHERE ${kind === 'financier' ? 'user_id' : 'id'}=$1`, [key], db);
  requireCondition(record, 404, 'Organisation not found');
  return { ref, counterparty: state.counterparty, key, record, state };
}

// ── access ──────────────────────────────────────────────────────────────────
type Access = { ops: boolean; self: boolean };
/** Syndicate works on every file; a supplier works on its own file only (S2). Anchors and funders have no access yet. */
async function access(actor: Actor, ref: string, db: DB): Promise<Access> {
  if (actor.role === 'platform_ops' && !actor.delegation) return { ops: true, self: false };
  const own = await orgRef(actor, db);
  requireCondition(own === ref && actor.role === 'supplier_user' && ['administrator', null].includes(actor.org_role ?? null), 403, 'This compliance file is outside your organisation');
  return { ops: false, self: true };
}
/** Who may change the file in its current state: Syndicate during set-up, the supplier while registering or when asked for more. */
async function requireEditable(actor: Actor, file: File, who: Access, db: DB) {
  if (who.self) requireCondition(SUPPLIER_EDITABLE.includes(file.state.status), 409, 'Your verification has been submitted. You can change it if the reviewer asks for more information.');
  else {
    requireCondition(await hasOpsRole(actor, 'relationship_manager', db) || await hasOpsRole(actor, 'compliance_officer', db), 403, 'This step needs the relationship manager or compliance officer role');
    requireCondition(file.counterparty === 'SUPPLIER' ? SUPPLIER_EDITABLE.includes(file.state.status) : EDITABLE_SETUP.includes(file.state.status), 409, 'The compliance file is locked while it is under review or after sign-off');
  }
}

// ── checklist (A2.1, F1.3, S2.1) ────────────────────────────────────────────
async function checklist(file: File, db: DB) {
  const country = String(file.record.country ?? '*').toUpperCase();
  const tier = file.counterparty === 'SUPPLIER' ? file.state.tier ?? 'simplified' : 'standard';
  // The most specific configuration wins: the organisation's country, otherwise the default ('*').
  const items = await rows(`SELECT DISTINCT ON (item_key) * FROM compliance_checklist_items WHERE counterparty=$1 AND tier=$2 AND country IN ($3,'*') ORDER BY item_key, (country='*'), sort`, [file.counterparty, tier, country], db);
  const filed = await rows('SELECT c.id,c.item_key,c.document_id,c.issued_on,c.expires_on,c.filed_at,d.file_name,d.size_bytes,d.review_status FROM compliance_documents c JOIN documents d ON d.id=c.document_id WHERE c.org_ref=$1 AND c.removed_at IS NULL ORDER BY c.id', [file.ref], db);
  return items.sort((a, b) => a.sort - b.sort).map(item => {
    const documents = filed.filter(f => f.item_key === item.item_key);
    const current = documents.filter(d => !d.expires_on || d.expires_on >= today());
    const state = !documents.length ? 'missing' : !current.length ? 'expired' : item.expires && current.some(d => !d.expires_on) ? 'expiry_missing' : 'filed';
    return { key: item.item_key, label: item.label, guidance: item.guidance, expires: item.expires, state, documents };
  });
}
const documentInput = z.object({ item_key: text(100).min(1), document_id: id, issued_on: date.optional(), expires_on: date.optional() });
async function fileDocument(actor: Actor, ref: string, body: unknown) {
  return transaction(async db => {
    const who = await access(actor, ref, db);
    const file = await load(ref, db, true);
    await requireEditable(actor, file, who, db);
    const data = documentInput.parse(body);
    const item = (await checklist(file, db)).find(i => i.key === data.item_key);
    requireCondition(item, 422, 'Choose an item from this organisation’s checklist');
    requireCondition(!item.expires || data.expires_on, 422, `Enter the expiry date of the ${item.label.toLowerCase()}`);
    requireCondition(!data.expires_on || data.expires_on >= today(), 422, 'This document has already expired; file a current one');
    requireCondition(!data.issued_on || data.issued_on <= today(), 422, 'The issue date cannot be in the future');
    const [doc] = await rows('SELECT id,org_ref,uploaded_by,on_behalf_of_user_id,upload_status,archived_at FROM documents WHERE id=$1 FOR UPDATE', [data.document_id], db);
    requireCondition(doc && doc.upload_status === 'stored' && !doc.archived_at, 422, 'The document is not available');
    requireCondition(!doc.org_ref || doc.org_ref === ref, 403, 'This document belongs to another organisation');
    if (who.self) requireCondition(same(doc.uploaded_by, actor.id) || same(doc.on_behalf_of_user_id, actor.id), 403, 'Upload the document yourself first');
    if (file.counterparty === 'SUPPLIER') await rows('UPDATE documents SET org_ref=$2,supplier_id=coalesce(supplier_id,$3::bigint),category=$4,updated_at=now() WHERE id=$1', [doc.id, ref, file.key, data.item_key], db);
    else if (file.counterparty === 'ANCHOR') await rows('UPDATE documents SET org_ref=$2,buyer_id=coalesce(buyer_id,$3::bigint),category=$4,updated_at=now() WHERE id=$1', [doc.id, ref, file.key, data.item_key], db);
    else await rows('UPDATE documents SET org_ref=$2,category=$3,updated_at=now() WHERE id=$1', [doc.id, ref, data.item_key], db);
    const [row] = await rows('INSERT INTO compliance_documents(org_ref,item_key,document_id,issued_on,expires_on,filed_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [ref, data.item_key, doc.id, data.issued_on ?? null, data.expires_on ?? null, actor.id], db);
    await portalEvent(actor, 'compliance.document_filed', null, null, { org_ref: ref, record_id: ref, item_key: data.item_key, document_id: doc.id }, db);
    return { id: String(row.id) };
  });
}
async function removeDocument(actor: Actor, ref: string, filedId: string) {
  return transaction(async db => {
    const who = await access(actor, ref, db);
    const file = await load(ref, db, true);
    await requireEditable(actor, file, who, db);
    const [row] = await rows('UPDATE compliance_documents SET removed_at=now() WHERE id=$1 AND org_ref=$2 AND removed_at IS NULL RETURNING item_key', [filedId, ref], db);
    requireCondition(row, 404, 'Filed document not found');
    await portalEvent(actor, 'compliance.document_removed', null, null, { org_ref: ref, record_id: ref, item_key: row.item_key }, db);
    return { removed: true };
  });
}

// ── beneficial ownership (A2.3, S2.3) ───────────────────────────────────────
const ownerInput = z.object({
  parent_id: id.optional(), kind: z.enum(['natural', 'entity']), name: text(200).min(2, 'Enter the name'),
  nationality: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).optional(), date_of_birth: date.optional(),
  ownership_percent: z.coerce.number().min(0).max(100).optional(), is_director: z.boolean().default(false), evidence_document_id: id.optional(),
});
async function owners(ref: string, db: DB) {
  return rows('SELECT id,parent_id,kind,name,nationality,date_of_birth,ownership_percent,is_director,evidence_document_id FROM beneficial_owners WHERE org_ref=$1 AND removed_at IS NULL ORDER BY id', [ref], db);
}
/** Effective ownership of each node, its chain checks, and who the beneficial owners are at the configured threshold. */
export function ownership(list: Row[], threshold: number) {
  const children = (parent: string | null) => list.filter(o => (o.parent_id == null ? null : String(o.parent_id)) === parent);
  const effective = new Map<string, number>();
  const walk = (parent: string | null, factor: number) => { for (const o of children(parent)) { const share = factor * Number(o.ownership_percent ?? 0) / 100; effective.set(String(o.id), share * 100); walk(String(o.id), share); } };
  walk(null, 1);
  const problems: string[] = [];
  const sum = (parent: string | null) => children(parent).reduce((total, o) => total + Number(o.ownership_percent ?? 0), 0);
  if (sum(null) > 100.0001) problems.push('Direct ownership adds up to more than 100%');
  for (const o of list.filter(x => x.kind === 'entity')) {
    if (sum(String(o.id)) > 100.0001) problems.push(`The owners of ${o.name} add up to more than 100%`);
    if ((effective.get(String(o.id)) ?? 0) >= threshold && !children(String(o.id)).length) problems.push(`${o.name} holds ${(effective.get(String(o.id)) ?? 0).toFixed(1)}%; record the natural persons behind it`);
  }
  if (!list.some(o => o.is_director)) problems.push('Record at least one director');
  const ubos = list.filter(o => o.kind === 'natural' && (effective.get(String(o.id)) ?? 0) >= threshold);
  return { effective: Object.fromEntries(effective), problems, ubos, directors: list.filter(o => o.is_director) };
}
async function addOwner(actor: Actor, ref: string, body: unknown) {
  return transaction(async db => {
    const who = await access(actor, ref, db);
    const file = await load(ref, db, true);
    await requireEditable(actor, file, who, db);
    const data = ownerInput.parse(body);
    requireCondition(data.kind === 'natural' || !data.is_director, 422, 'Only a person can be a director');
    requireCondition(data.is_director || data.ownership_percent !== undefined, 422, 'Enter the ownership percentage, or mark the person as a director');
    if (data.parent_id) {
      const [parent] = await rows("SELECT id FROM beneficial_owners WHERE id=$1 AND org_ref=$2 AND kind='entity' AND removed_at IS NULL", [data.parent_id, ref], db);
      requireCondition(parent, 422, 'Choose a company owner as the parent');
    }
    const [row] = await rows('INSERT INTO beneficial_owners(org_ref,parent_id,kind,name,nationality,date_of_birth,ownership_percent,is_director,evidence_document_id,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
      [ref, data.parent_id ?? null, data.kind, data.name, data.nationality ?? null, data.date_of_birth ?? null, data.ownership_percent ?? null, data.is_director, data.evidence_document_id ?? null, actor.id], db);
    await portalEvent(actor, 'compliance.owner_recorded', null, null, { org_ref: ref, record_id: ref, owner_id: row.id }, db);
    return { id: String(row.id) };
  });
}
async function removeOwner(actor: Actor, ref: string, ownerId: string) {
  return transaction(async db => {
    const who = await access(actor, ref, db);
    const file = await load(ref, db, true);
    await requireEditable(actor, file, who, db);
    requireCondition(!(await rows('SELECT 1 FROM beneficial_owners WHERE parent_id=$1 AND removed_at IS NULL', [ownerId], db)).length, 409, 'Remove the owners recorded under this company first');
    const [row] = await rows('UPDATE beneficial_owners SET removed_at=now() WHERE id=$1 AND org_ref=$2 AND removed_at IS NULL RETURNING id', [ownerId, ref], db);
    requireCondition(row, 404, 'Owner not found');
    await portalEvent(actor, 'compliance.owner_removed', null, null, { org_ref: ref, record_id: ref, owner_id: ownerId }, db);
    return { removed: true };
  });
}

// ── screening (A2.4, F1.7, S2.3) ────────────────────────────────────────────
const normal = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
async function screeningSubjects(file: File, db: DB) {
  const threshold = Number(await setting('beneficial_owner_threshold_percent', db) ?? 25);
  const tree = ownership(await owners(file.ref, db), threshold);
  const subjects: Array<{ type: string; name: string }> = [{ type: 'organisation', name: String(file.record.legal_name || file.record.name) }];
  for (const person of [...tree.ubos, ...tree.directors]) if (!subjects.some(s => normal(s.name) === normal(person.name))) subjects.push({ type: 'individual', name: person.name });
  if (file.counterparty !== 'SUPPLIER') for (const signatory of await rows('SELECT name FROM authorised_signatories WHERE org_ref=$1 AND removed_at IS NULL', [file.ref], db))
    if (!subjects.some(s => normal(s.name) === normal(signatory.name))) subjects.push({ type: 'signatory', name: signatory.name });
  const results = await rows('SELECT s.*,u.name AS recorded_by_name FROM party_screenings s LEFT JOIN users u ON u.id=s.recorded_by WHERE s.org_ref=$1 ORDER BY s.id DESC', [file.ref], db);
  return subjects.map(subject => {
    const latest = results.find(r => normal(r.subject_name) === normal(subject.name));
    const state = !latest ? 'not_screened' : latest.outcome === 'clear' || latest.resolution === 'false_positive' ? 'clear' : latest.resolution === 'confirmed' || latest.outcome === 'confirmed_match' ? 'confirmed_match' : 'potential_match';
    return { ...subject, state, latest: latest ?? null };
  });
}
const screeningInput = z.object({ subject_type: z.enum(['organisation', 'individual', 'signatory']), subject_name: text(200).min(2), outcome: z.enum(['clear', 'potential_match', 'confirmed_match']), reference: text(200).optional(), notes: text(4000).optional(), lists: z.array(z.enum(['sanctions', 'pep', 'adverse_media'])).min(1).default(['sanctions', 'pep', 'adverse_media']) });
async function recordScreening(actor: Actor, ref: string, body: unknown) {
  return transaction(async db => {
    requireCondition(actor.role === 'platform_ops', 403, 'Screening is performed by INVOX');
    requireCondition(await hasOpsRole(actor, 'relationship_manager', db) || await hasOpsRole(actor, 'compliance_officer', db), 403, 'This step needs the relationship manager or compliance officer role');
    const file = await load(ref, db, true);
    const data = screeningInput.parse(body);
    requireCondition(data.lists.length === 3 || data.outcome !== 'clear', 422, 'A clear result must cover sanctions, PEP and adverse media');
    const [row] = await rows('INSERT INTO party_screenings(org_ref,subject_type,subject_name,provider,lists,outcome,reference,payload,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [ref, data.subject_type, data.subject_name, 'manual', JSON.stringify(data.lists), data.outcome, data.reference ?? null, JSON.stringify({ notes: data.notes ?? null }), actor.id], db);
    // A hit is never silent: it opens a compliance task with the subject named.
    if (data.outcome !== 'clear') await rows("INSERT INTO portal_exceptions(org_ref,kind,summary,status,updated_by) VALUES($1,'COMPLIANCE_REVIEW',$2,'OPEN',$3)", [ref, `Screening ${data.outcome.replace('_', ' ')} for ${data.subject_name} (${file.record.legal_name || file.record.name})`, actor.id], db);
    await portalEvent(actor, 'compliance.screened', null, null, { org_ref: ref, record_id: ref, screening_id: row.id, outcome: data.outcome }, db);
    return { id: String(row.id) };
  });
}
const resolveInput = z.object({ resolution: z.enum(['false_positive', 'confirmed']), note: text(4000).min(10, 'Explain the resolution (at least 10 characters)') });
async function resolveScreening(actor: Actor, ref: string, screeningId: string, body: unknown) {
  return transaction(async db => {
    await requireOpsRole(actor, 'compliance_officer', db);
    const data = resolveInput.parse(body);
    const [hit] = await rows("SELECT * FROM party_screenings WHERE id=$1 AND org_ref=$2 AND outcome<>'clear' AND resolution IS NULL FOR UPDATE", [screeningId, ref], db);
    requireCondition(hit, 404, 'Open screening result not found');
    requireCondition(!same(hit.recorded_by, actor.id), 403, 'A different person must resolve the screening result');
    await rows('UPDATE party_screenings SET resolution=$2,resolution_note=$3,resolved_by=$4,resolved_at=now() WHERE id=$1', [screeningId, data.resolution, data.note, actor.id], db);
    await portalEvent(actor, 'compliance.screening_resolved', data.note, null, { org_ref: ref, record_id: ref, screening_id: screeningId, resolution: data.resolution }, db);
    return { resolved: true };
  });
}

// ── bank accounts (A2.5, F1, S2.4) ──────────────────────────────────────────
const accountInput = z.object({
  bank_name: text(200).min(2, 'Enter the bank'), bank_code: text(50).optional(), account_number: z.string().trim().transform(value => value.replace(/\s+/g, '')),
  account_name: text(200).min(2, 'Enter the account name'), currency: z.enum(['GHS', 'USD', 'EUR', 'NGN', 'KES']).default('GHS'),
  evidence_document_id: id, name_check: z.enum(['match', 'mismatch', 'not_available']).optional(), authorised_by_signatory_id: id.optional(),
});
const corporate = (name: string) => normal(name).replace(/\b(limited|ltd|plc|llc|inc|company|co|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
function validAccount(country: string, number: string) { return country === 'GH' ? /^\d{10,16}$/.test(number) : /^[A-Za-z0-9]{6,34}$/.test(number); }
async function addAccount(actor: Actor, ref: string, body: unknown) {
  return transaction(async db => {
    const who = await access(actor, ref, db);
    const file = await load(ref, db, true);
    const data = accountInput.parse(body);
    const purpose = ACCOUNT_PURPOSE[file.counterparty];
    const [live] = await rows("SELECT id FROM settlement_accounts WHERE org_ref=$1 AND purpose=$2 AND currency=$3 AND status='VERIFIED'", [ref, purpose, data.currency], db);
    if (who.self) {
      requireCondition(SUPPLIER_EDITABLE.includes(file.state.status), 409, 'Your verification has been submitted');
      // Self-service entry only at first-time onboarding (S2.4); a later change is a signed written request (S7).
      requireCondition(!live && !(await rows("SELECT 1 FROM settlement_accounts WHERE org_ref=$1 AND status='VERIFIED'", [ref], db)).length, 409, 'Your bank account is verified and can only be changed by a signed written request to INVOX');
      requireCondition(!(await rows("SELECT 1 FROM settlement_accounts WHERE org_ref=$1 AND status='PENDING_VERIFICATION'", [ref], db)).length, 409, 'Remove the account awaiting verification before adding another');
    } else {
      requireCondition(await hasOpsRole(actor, 'relationship_manager', db) || await hasOpsRole(actor, 'compliance_officer', db), 403, 'This step needs the relationship manager or compliance officer role');
      requireCondition(!['DECLINED', 'CLOSED', 'SETUP_ABANDONED'].includes(file.state.status), 409, 'Accounts cannot be added for this organisation');
      // Changing a verified account must be authorised by a recorded signatory (A2.5, FR-JNY-F-007).
      if (live && file.counterparty !== 'SUPPLIER') {
        requireCondition(data.authorised_by_signatory_id, 422, 'Changing a verified account needs the authorising signatory');
        requireCondition((await rows('SELECT 1 FROM authorised_signatories WHERE id=$1 AND org_ref=$2 AND removed_at IS NULL', [data.authorised_by_signatory_id, ref], db)).length, 422, 'Choose one of this organisation’s authorised signatories');
      }
    }
    requireCondition(validAccount(String(file.record.country ?? '').toUpperCase(), data.account_number), 422, 'Enter a valid account number for this country');
    const [doc] = await rows('SELECT id,org_ref,uploaded_by,on_behalf_of_user_id,upload_status FROM documents WHERE id=$1', [data.evidence_document_id], db);
    requireCondition(doc && doc.upload_status === 'stored' && (!doc.org_ref || doc.org_ref === ref), 422, 'Attach the bank statement or bank letter');
    if (who.self) requireCondition(same(doc.uploaded_by, actor.id), 403, 'Upload the bank evidence yourself first');
    await rows('UPDATE documents SET org_ref=$2,category=$3,updated_at=now() WHERE id=$1', [doc.id, ref, 'bank_evidence'], db);
    // The account name must match the verified legal entity; a mismatch goes to manual review rather than being refused.
    const nameCheck = who.self || !data.name_check ? (corporate(data.account_name) === corporate(String(file.record.legal_name || file.record.name)) ? 'match' : 'mismatch') : data.name_check;
    const [row] = await rows(`INSERT INTO settlement_accounts(org_ref,purpose,bank_name,bank_code,account_number,account_name,currency,evidence_document_id,name_check,authorised_by_signatory_id,replaces_id,recorded_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [ref, purpose, data.bank_name, data.bank_code ?? null, data.account_number, data.account_name, data.currency, doc.id, nameCheck, data.authorised_by_signatory_id ?? null, live?.id ?? null, actor.id], db);
    await portalEvent(actor, 'compliance.account_recorded', null, null, { org_ref: ref, record_id: ref, account_id: row.id, name_check: nameCheck, change: !!live }, db);
    if (live) await notifyAccountChange(actor, file, 'A change to your bank account is awaiting verification', `A new ${purpose} account ending ${data.account_number.slice(-4)} was recorded and is awaiting verification. If you did not request this, contact INVOX immediately.`, db);
    return { id: String(row.id), name_check: nameCheck };
  });
}
async function removeAccount(actor: Actor, ref: string, accountId: string) {
  return transaction(async db => {
    const who = await access(actor, ref, db);
    const file = await load(ref, db, true);
    if (who.self) requireCondition(SUPPLIER_EDITABLE.includes(file.state.status), 409, 'Your verification has been submitted');
    const [row] = await rows("UPDATE settlement_accounts SET status='REJECTED',decision_note='Withdrawn before verification' WHERE id=$1 AND org_ref=$2 AND status='PENDING_VERIFICATION' AND ($3 OR recorded_by=$4) RETURNING id", [accountId, ref, who.ops, actor.id], db);
    requireCondition(row, 404, 'Only an account awaiting verification can be removed');
    await portalEvent(actor, 'compliance.account_withdrawn', null, null, { org_ref: ref, record_id: ref, account_id: accountId }, db);
    return { removed: true };
  });
}
/** Every administrator of the organisation and the Syndicate team are told about any bank-account change (A2.5). */
async function notifyAccountChange(actor: Actor, file: File, subject: string, body: string, db: DB) {
  const people = await rows(`SELECT id FROM users WHERE disabled_at IS NULL AND provisioning_status='ACTIVE' AND (org_ref=$1 OR ${file.counterparty === 'ANCHOR' ? 'buyer_id=$2' : 'id=$2'}) AND coalesce(org_role,'administrator') IN ('administrator','relationship_owner','operations')`, [file.ref, file.counterparty === 'SUPPLIER' ? (file.record.user_id ?? 0) : file.key], db);
  for (const person of people) await notify(String(person.id), subject, body, null, actor, db);
}
const accountDecision = z.object({ decision: z.enum(['verify', 'reject']), note: text(2000).optional() });
async function verifyAccount(actor: Actor, ref: string, accountId: string, body: unknown) {
  const data = accountDecision.parse(body);
  return transaction(async db => {
    requireCondition(actor.role === 'platform_ops' && !actor.delegation, 403, 'Bank accounts are verified by INVOX');
    requireCondition(await hasOpsRole(actor, 'compliance_officer', db) || await hasOpsRole(actor, 'operations_analyst', db), 403, 'This step needs the compliance officer or operations analyst role');
    const file = await load(ref, db, true);
    const [account] = await rows("SELECT * FROM settlement_accounts WHERE id=$1 AND org_ref=$2 AND status='PENDING_VERIFICATION' FOR UPDATE", [accountId, ref], db);
    requireCondition(account, 404, 'Account awaiting verification not found');
    requireCondition(!same(account.recorded_by, actor.id), 403, 'A different person must verify the account');
    if (data.decision === 'verify' && account.name_check === 'mismatch') requireCondition((data.note?.length ?? 0) >= 10, 422, 'The account name does not match the legal entity; record why it is acceptable');
    if (data.decision === 'reject') requireCondition((data.note?.length ?? 0) >= 10, 422, 'Explain why the account is rejected');
    if (data.decision === 'verify') {
      const days = Number(await setting('account_cool_off_days', db) ?? 3);
      await rows("UPDATE settlement_accounts SET status='SUPERSEDED' WHERE org_ref=$1 AND purpose=$2 AND currency=$3 AND status='VERIFIED'", [ref, account.purpose, account.currency], db);
      await rows("UPDATE settlement_accounts SET status='VERIFIED',verified_by=$2,verified_at=now(),usable_from=now()+make_interval(days => $3),decision_note=$4 WHERE id=$1", [accountId, actor.id, days, data.note ?? null], db);
      await rows("UPDATE documents SET review_status='verified',verified_by=$2,verified_at=now() WHERE id=$1 AND review_status='pending' AND uploaded_by<>$2", [account.evidence_document_id, actor.id], db);
      if (account.replaces_id) await notifyAccountChange(actor, file, 'Your bank account was changed', `The ${account.purpose} account ending ${String(account.account_number).slice(-4)} is now verified and replaces the previous account from ${new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)}. If you did not request this, contact INVOX immediately.`, db);
    } else await rows("UPDATE settlement_accounts SET status='REJECTED',verified_by=NULL,decision_note=$2 WHERE id=$1", [accountId, data.note], db);
    await portalEvent(actor, `compliance.account_${data.decision === 'verify' ? 'verified' : 'rejected'}`, data.note ?? null, null, { org_ref: ref, record_id: ref, account_id: accountId }, db);
    return { status: data.decision === 'verify' ? 'VERIFIED' : 'REJECTED' };
  });
}

// ── supplier's own company details (S1.4) and tier (S2.1) ───────────────────
const profileInput = z.object({ legal_name: text(200).min(2), trading_name: text(200).optional(), registration_number: text(100).min(1), country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/), registered_address: text(500).min(3), tax_id: text(100).optional(), industry: text(200).optional(), contact_phone: text(100).optional() }).partial();
async function updateSupplierProfile(actor: Actor, ref: string, body: unknown) {
  return transaction(async db => {
    const who = await access(actor, ref, db);
    const file = await load(ref, db, true);
    requireCondition(file.counterparty === 'SUPPLIER', 404, 'Not found');
    await requireEditable(actor, file, who, db);
    const data = profileInput.parse(body);
    const registration = data.registration_number ?? file.record.registration_number; const country = data.country ?? file.record.country;
    if (registration && country) {
      const [clash] = await rows(`SELECT 1 FROM (SELECT 'buyer-'||id AS ref,country,registration_number FROM buyers UNION ALL SELECT 'financier-'||user_id,country,registration_number FROM financier_profiles UNION ALL SELECT 'supplier-'||id,country,registration_number FROM suppliers) o
        WHERE upper(country)=upper($1) AND lower(trim(registration_number))=lower(trim($2)) AND ref<>$3 LIMIT 1`, [country, registration, ref], db);
      requireCondition(!clash, 409, 'This registration number is already registered on INVOX. Contact INVOX so your existing account can be linked.');
    }
    const set = Object.entries(data).filter(([, value]) => value !== undefined);
    requireCondition(set.length, 422, 'No changes were supplied');
    const values = Object.fromEntries(set);
    if (values.trading_name || values.legal_name) values.name = values.trading_name ?? values.legal_name;
    const keys = Object.keys(values);
    await rows(`UPDATE suppliers SET ${keys.map((k, i) => `"${k}"=$${i + 2}`).join(',')},updated_at=now() WHERE id=$1`, [file.key, ...keys.map(k => values[k])], db);
    await portalEvent(actor, 'compliance.profile_updated', null, null, { org_ref: ref, record_id: ref }, db);
    return { saved: true };
  });
}
async function setTier(actor: Actor, ref: string, body: Row) {
  return transaction(async db => {
    await requireOpsRole(actor, 'compliance_officer', db);
    const file = await load(ref, db, true);
    requireCondition(file.counterparty === 'SUPPLIER', 422, 'Only suppliers have a diligence tier');
    const tier = z.enum(['simplified', 'full']).parse(body.tier);
    const reason = text(2000).min(10, 'State why the tier changes').parse(body.reason);
    await rows('UPDATE organisation_lifecycle SET tier=$2,updated_at=now() WHERE org_ref=$1', [ref, tier], db);
    await portalEvent(actor, 'compliance.tier_set', reason, null, { org_ref: ref, record_id: ref, tier }, db);
    return { tier };
  });
}

// ── completeness, submission and decision (A2.6–A2.7, F1.7–F1.8, S2.5–S2.6) ─
async function view(file: File, db: DB, who: Access) {
  const threshold = Number(await setting('beneficial_owner_threshold_percent', db) ?? 25);
  const items = await checklist(file, db);
  const ownerList = await owners(file.ref, db);
  const tree = ownership(ownerList, threshold);
  const subjects = await screeningSubjects(file, db);
  const accounts = await rows('SELECT a.id,a.purpose,a.bank_name,a.bank_code,a.account_name,a.currency,a.status,a.name_check,a.usable_from,a.verified_at,a.decision_note,a.created_at,a.replaces_id,a.recorded_by,right(a.account_number,4) AS last4,a.account_number,d.file_name AS evidence_file,a.evidence_document_id FROM settlement_accounts a LEFT JOIN documents d ON d.id=a.evidence_document_id WHERE a.org_ref=$1 AND a.status<>\'SUPERSEDED\' ORDER BY a.id DESC', [file.ref], db);
  const reviews = await rows('SELECT r.id,r.submitted_at,r.decision,r.decided_at,r.risk_rating,r.outstanding_items,CASE WHEN $2 THEN r.note END AS note,su.name AS submitted_by_name,du.name AS decided_by_name,r.submitted_by FROM compliance_reviews r LEFT JOIN users su ON su.id=r.submitted_by LEFT JOIN users du ON du.id=r.decided_by WHERE r.org_ref=$1 ORDER BY r.id DESC', [file.ref, who.ops], db);
  const purpose = ACCOUNT_PURPOSE[file.counterparty];
  const problems: string[] = [];
  if (file.counterparty !== 'SUPPLIER') {
    problems.push(...await provisioningProblems({ ref: file.ref, counterparty: file.counterparty, key: file.key, record: file.record }, db));
    if (!(await rows('SELECT 1 FROM authorised_signatories WHERE org_ref=$1 AND removed_at IS NULL', [file.ref], db)).length) problems.push('Record at least one authorised signatory');
    const contacts = await rows('SELECT purpose FROM organisation_contacts WHERE org_ref=$1', [file.ref], db);
    for (const purposeKey of requiredContacts(file.counterparty)) if (!contacts.some(c => c.purpose === purposeKey)) problems.push(`Record the ${purposeKey === 'it' ? 'IT (data delivery)' : purposeKey} contact`);
  } else {
    for (const [field, label] of [['legal_name', 'legal name'], ['registration_number', 'registration number'], ['registered_address', 'registered address']] as const) if (!file.record[field]) problems.push(`Confirm your company’s ${label}`);
  }
  for (const item of items) if (item.state !== 'filed') problems.push(item.state === 'missing' ? `File the ${item.label.toLowerCase()}` : item.state === 'expired' ? `The ${item.label.toLowerCase()} has expired; file a current one` : `Enter the expiry date of the ${item.label.toLowerCase()}`);
  problems.push(...tree.problems);
  if (!accounts.some(a => a.purpose === purpose && ['PENDING_VERIFICATION', 'VERIFIED'].includes(a.status))) problems.push(`Record ${ACCOUNT_LABEL[file.counterparty]}, with the bank statement or letter`);
  // Screening is performed by INVOX; for a supplier it happens after submission, during review.
  const screeningProblems = subjects.filter(s => s.state !== 'clear').map(s => s.state === 'not_screened' ? `Screen ${s.name}` : s.state === 'potential_match' ? `Resolve the potential screening match for ${s.name}` : `${s.name} is a confirmed screening match`);
  const accountProblems = accounts.some(a => a.purpose === purpose && a.status === 'VERIFIED') ? [] : [`Verify ${ACCOUNT_LABEL[file.counterparty]}`];
  const base = { ref: file.ref, counterparty: file.counterparty, name: file.record.legal_name || file.record.name, status: file.state.status, tier: file.state.tier, risk_rating: file.state.risk_rating, re_verification_due: file.state.re_verification_due,
    profile: file.counterparty === 'SUPPLIER' ? { legal_name: file.record.legal_name, trading_name: file.record.trading_name, registration_number: file.record.registration_number, country: file.record.country, registered_address: file.record.registered_address, tax_id: file.record.tax_id, industry: file.record.industry, contact_phone: file.record.contact_phone } : null,
    checklist: items, owners: ownerList.map((o: Row) => ({ ...o, effective_percent: tree.effective[String(o.id)] ?? null }) as Row), beneficial_owner_threshold: threshold,
    accounts: accounts.map(({ account_number, recorded_by, ...a }: Row) => ({ ...a, account_number: who.ops ? account_number : undefined, recorded_by: who.ops ? recorded_by : undefined }) as Row),
    submission_problems: who.ops || file.counterparty !== 'SUPPLIER' ? [...problems, ...(file.counterparty === 'SUPPLIER' ? [] : screeningProblems)] : problems,
    signoff_problems: [...problems, ...screeningProblems, ...accountProblems],
    reviews: who.ops ? reviews : reviews.map(r => ({ submitted_at: r.submitted_at, decision: r.decision, decided_at: r.decided_at, outstanding_items: r.decision === 'referred' ? r.outstanding_items : [] })) };
  const signatories = file.counterparty === 'SUPPLIER' ? [] : await rows('SELECT id,name,title FROM authorised_signatories WHERE org_ref=$1 AND removed_at IS NULL ORDER BY id', [file.ref], db);
  return who.ops ? { ...base, screening: subjects, signatories } : base;
}
async function getFile(actor: Actor, ref: string) {
  return transaction(async db => { const who = await access(actor, ref, db); return view(await load(ref, db), db, who); });
}
async function submit(actor: Actor, ref: string) {
  return transaction(async db => {
    const who = await access(actor, ref, db);
    const file = await load(ref, db, true);
    await requireEditable(actor, file, who, db);
    const current = await view(file, db, who);
    requireCondition(!current.submission_problems.length, 422, `Before submitting: ${current.submission_problems.join('; ')}`);
    const target = file.counterparty === 'SUPPLIER' ? 'KYC_IN_REVIEW' : 'COMPLIANCE_REVIEW';
    await transition(ref, target, actor, file.counterparty === 'SUPPLIER' ? 'Supplier submitted its verification' : 'Compliance file submitted for sign-off', db);
    await rows('INSERT INTO compliance_reviews(org_ref,submitted_by,snapshot) VALUES($1,$2,$3)', [ref, actor.id, JSON.stringify({ checklist: current.checklist.map(i => ({ key: i.key, documents: i.documents.map(d => d.document_id) })), owners: current.owners.map(o => o.id), accounts: current.accounts.map(a => a.id) })], db);
    await rows(`INSERT INTO portal_org_reviews(org_ref,status,payload,submitted_by) VALUES($1,'PENDING_REVIEW',$2,$3) ON CONFLICT(org_ref) DO UPDATE SET status='PENDING_REVIEW',payload=$2,note=NULL,submitted_by=$3,submitted_at=now()`, [ref, JSON.stringify({ source: 'compliance_file' }), actor.id], db);
    if (file.counterparty === 'SUPPLIER') await rows("UPDATE suppliers SET verification_status='pending',onboarding_status='KYC_IN_REVIEW',updated_at=now() WHERE id=$1", [file.key], db);
    const officers = await rows("SELECT id FROM users WHERE role=2 AND disabled_at IS NULL AND id<>$1 AND (ops_roles IS NULL OR 'compliance_officer'=ANY(ops_roles))", [actor.id], db);
    for (const officer of officers) await notify(String(officer.id), 'Compliance file awaiting sign-off', `${current.name} is waiting for compliance review.`, null, actor, db);
    await portalEvent(actor, 'compliance.submitted', null, null, { org_ref: ref, record_id: ref }, db);
    return { status: target };
  });
}
const decisionInput = z.object({ decision: z.enum(['sign_off', 'refer', 'decline']), risk_rating: z.enum(['low', 'medium', 'high']).optional(), outstanding_items: z.array(text(500).min(3)).max(30).default([]), note: text(4000).optional() });
async function decide(actor: Actor, ref: string, body: unknown) {
  const data = decisionInput.parse(body);
  return transaction(async db => {
    await requireOpsRole(actor, 'compliance_officer', db);
    const file = await load(ref, db, true);
    requireCondition(['COMPLIANCE_REVIEW', 'KYC_IN_REVIEW'].includes(file.state.status), 409, 'This file is not awaiting a compliance decision');
    const [review] = await rows('SELECT * FROM compliance_reviews WHERE org_ref=$1 AND decision IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE', [ref], db);
    requireCondition(review, 409, 'No submission is awaiting a decision');
    requireCondition(!same(review.submitted_by, actor.id), 403, 'A different person must decide on the file they submitted');
    const current = await view(file, db, { ops: true, self: false });
    let target: string; let reviewStatus: string; let note = data.note ?? null;
    if (data.decision === 'sign_off') {
      requireCondition(!current.signoff_problems.length, 422, `Before signing off: ${current.signoff_problems.join('; ')}`);
      requireCondition(data.risk_rating, 422, 'Assign a risk rating');
      target = 'VERIFIED'; reviewStatus = 'APPROVED';
    } else if (data.decision === 'refer') {
      requireCondition(data.outstanding_items.length, 422, 'List exactly what is outstanding');
      target = file.counterparty === 'ANCHOR' ? 'DOCUMENTATION_OUTSTANDING' : file.counterparty === 'FUNDER' ? 'INFO_OUTSTANDING' : 'INFO_REQUIRED'; reviewStatus = 'INFO_REQUIRED';
      note = data.outstanding_items.join('\n');
    } else {
      requireCondition((data.note?.length ?? 0) >= 10, 422, 'Record the reason for declining (kept internal)');
      target = 'DECLINED'; reviewStatus = 'REJECTED';
    }
    await transition(ref, target, actor, data.decision === 'sign_off' ? `Compliance sign-off (risk ${data.risk_rating})` : data.decision === 'refer' ? `Referred back: ${data.outstanding_items.length} item(s) outstanding` : 'Declined following compliance review', db);
    await rows('UPDATE compliance_reviews SET decision=$2,decided_by=$3,decided_at=now(),risk_rating=$4,outstanding_items=$5,note=$6 WHERE id=$1', [review.id, data.decision === 'sign_off' ? 'signed_off' : data.decision === 'refer' ? 'referred' : 'declined', actor.id, data.risk_rating ?? null, JSON.stringify(data.outstanding_items), data.note ?? null], db);
    // The decline reason stays internal; the organisation sees a neutral outcome (S2.6).
    await rows('UPDATE portal_org_reviews SET status=$2,note=$3,reviewed_by=$4,reviewed_at=now() WHERE org_ref=$1', [ref, reviewStatus, data.decision === 'decline' ? null : note, actor.id], db);
    const table = file.counterparty === 'ANCHOR' ? 'buyers' : file.counterparty === 'FUNDER' ? 'financier_profiles' : 'suppliers';
    const keyColumn = file.counterparty === 'FUNDER' ? 'user_id' : 'id';
    if (data.decision === 'sign_off') {
      const months = (await setting<Record<string, number>>('re_verification_months', db))?.[data.risk_rating!] ?? 12;
      await rows("UPDATE organisation_lifecycle SET risk_rating=$2,re_verification_due=(current_date + make_interval(months => $3))::date WHERE org_ref=$1", [ref, data.risk_rating, months], db);
      await rows(`UPDATE ${table} SET verification_status='verified',approval_status='approved',risk_rating=$2,last_verified_at=now(),onboarding_status='VERIFIED',updated_at=now() WHERE ${keyColumn}=$1`, [file.key, data.risk_rating], db);
      const filed = current.checklist.flatMap(i => i.documents.map(d => d.document_id));
      await rows("UPDATE documents SET review_status='verified',verified_by=$2,verified_at=now() WHERE id=ANY($1::bigint[]) AND review_status='pending' AND uploaded_by<>$2", [filed, actor.id], db);
    } else await rows(`UPDATE ${table} SET verification_status=$2,onboarding_status=$3,updated_at=now() WHERE ${keyColumn}=$1`, [file.key, data.decision === 'refer' ? 'pending' : 'rejected', target], db);
    // Suppliers hear from the platform; anchors and funders are contacted by their relationship manager off-system.
    if (file.counterparty === 'SUPPLIER' && file.record.user_id) await notify(String(file.record.user_id), data.decision === 'sign_off' ? 'Your organisation is verified' : data.decision === 'refer' ? 'We need a little more information' : 'Update on your verification', data.decision === 'sign_off' ? 'Your verification is complete. Review and accept the programme terms to start.' : data.decision === 'refer' ? `Please provide: ${data.outstanding_items.join('; ')}` : 'We are unable to complete your verification. Your customer’s INVOX relationship manager will be in touch.', null, actor, db);
    await notify(String(review.submitted_by), `Compliance decision: ${data.decision.replace('_', ' ')}`, `${current.name}: ${target.toLowerCase().replaceAll('_', ' ')}.`, null, actor, db);
    await portalEvent(actor, `compliance.${data.decision === 'sign_off' ? 'signed_off' : data.decision === 'refer' ? 'referred' : 'declined'}`, data.decision === 'decline' ? null : note, null, { org_ref: ref, record_id: ref }, db);
    return { status: target };
  });
}

/** Files that need compliance attention, for the Syndicate queue. */
async function queue(actor: Actor) {
  requireCondition(actor.role === 'platform_ops' && !actor.delegation, 403, 'Forbidden');
  return rows(`SELECT l.org_ref AS ref,l.counterparty,l.status,l.tier,l.updated_at,coalesce(b.legal_name,b.name,f.legal_name,f.name,s.legal_name,s.name) AS name,
      (SELECT count(*)::int FROM settlement_accounts a WHERE a.org_ref=l.org_ref AND a.status='PENDING_VERIFICATION') AS accounts_pending,
      (SELECT count(*)::int FROM party_screenings r WHERE r.org_ref=l.org_ref AND r.outcome<>'clear' AND r.resolution IS NULL) AS open_hits
    FROM organisation_lifecycle l
    LEFT JOIN buyers b ON l.org_ref='buyer-'||b.id LEFT JOIN financier_profiles f ON l.org_ref='financier-'||f.user_id LEFT JOIN suppliers s ON l.org_ref='supplier-'||s.id
    WHERE NOT l.legacy AND l.status NOT IN ('SETUP_ABANDONED','CLOSED','DECLINED','INVITED')
    ORDER BY (l.status IN ('COMPLIANCE_REVIEW','KYC_IN_REVIEW')) DESC, l.updated_at`);
}

/** portal/compliance … */
export async function complianceRequest(actor: Actor, method: string, path: string[], body: Row): Promise<{ status?: number; data?: unknown }> {
  const [, , ref, section, itemId, action] = path;
  if (!ref && method === 'GET') return { data: await queue(actor) };
  requireCondition(ref, 404, 'Not found');
  if (!section && method === 'GET') return { data: await getFile(actor, ref) };
  if (section === 'profile' && method === 'PATCH') return { data: await updateSupplierProfile(actor, ref, body) };
  if (section === 'tier' && method === 'PUT') return { data: await setTier(actor, ref, body) };
  if (section === 'documents' && !itemId && method === 'POST') return { data: await fileDocument(actor, ref, body), status: 201 };
  if (section === 'documents' && itemId && method === 'DELETE') return { data: await removeDocument(actor, ref, id.parse(itemId)) };
  if (section === 'owners' && !itemId && method === 'POST') return { data: await addOwner(actor, ref, body), status: 201 };
  if (section === 'owners' && itemId && method === 'DELETE') return { data: await removeOwner(actor, ref, id.parse(itemId)) };
  if (section === 'screening' && !itemId && method === 'POST') return { data: await recordScreening(actor, ref, body), status: 201 };
  if (section === 'screening' && itemId && action === 'resolve' && method === 'POST') return { data: await resolveScreening(actor, ref, id.parse(itemId), body) };
  if (section === 'accounts' && !itemId && method === 'POST') return { data: await addAccount(actor, ref, body), status: 201 };
  if (section === 'accounts' && itemId && !action && method === 'DELETE') return { data: await removeAccount(actor, ref, id.parse(itemId)) };
  if (section === 'accounts' && itemId && action === 'verify' && method === 'POST') return { data: await verifyAccount(actor, ref, id.parse(itemId), body) };
  if (section === 'submit' && method === 'POST') return { data: await submit(actor, ref) };
  if (section === 'decide' && method === 'POST') return { data: await decide(actor, ref, body) };
  throw new ApiError(404, 'Compliance endpoint not found');
}
