import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type Actor } from '../auth';
import { rows, transaction, type DB, type Row } from '../db';
import { ApiError, requireCondition } from '../errors';
import { id, email, date } from '../validation';
import { portalEvent } from '../portal-support';
import { entityAudit } from '../fields';
import { isSuperAdmin } from '../act-for';
import { type Counterparty, EDITABLE_SETUP, history, lifecycle, startLifecycle, transition } from './lifecycle';
import { OPS_ROLES, OPS_ROLE_LABEL, opsRolesInput, requireOpsRole } from './roles';

/**
 * SRS stages A1 (anchor) and F1 (funder): Syndicate creates the organisation from executed off-system paperwork.
 * Nothing is collected from the organisation, which has no access until set-up and configuration are complete.
 *   A1.1/F1.1  set-up gate — the executed agreement reference, date and document are required before anything else
 *   A1.2/F1.2  organisation record, never duplicated on registration number + country
 *   A1.3/F1.5  named users pre-provisioned with their role (not activated, nothing sent), segregation of duties
 *   A1.4/F1.4  authorised signatories as structured data with their scope and authority
 *   A1.5       contacts per purpose, so notifications route by role
 */
const same = (a: unknown, b: unknown) => String(a) === String(b);
const text = (max: number) => z.string().trim().max(max);
const optional = (max: number) => text(max).optional().transform(value => value || null);
const country = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use a two-letter country code');
const today = () => new Date().toISOString().slice(0, 10);
const refPattern = /^(buyer|financier)-[1-9]\d{0,17}$/;
export const ORG_ROLES: Record<Counterparty, string[]> = {
  ANCHOR: ['administrator', 'approver', 'viewer'],
  FUNDER: ['relationship_owner', 'credit_officer', 'operations', 'auditor', 'custodian'],
  SUPPLIER: ['administrator', 'finance', 'viewer'],
};
export const ORG_ROLE_LABEL: Record<string, string> = {
  administrator: 'Administrator', approver: 'Approver (approves payables)', viewer: 'Viewer (read-only)', finance: 'Finance user',
  relationship_owner: 'Relationship owner', credit_officer: 'Credit officer (approves applications)', operations: 'Operations (cash and settlement)', auditor: 'Auditor (read-only)', custodian: 'Custodian',
};

async function setting<T>(key: string, db?: DB): Promise<T> {
  const [row] = await rows('SELECT value FROM onboarding_settings WHERE key=$1', [key], db);
  return row?.value as T;
}

// ── set-up gate and organisation record ─────────────────────────────────────
const agreementInput = z.object({
  reference: text(200).min(2, 'Enter the executed agreement reference'),
  executed_on: date,
  effective_on: date.optional(),
  expiry_on: date.optional(),
  document_ids: z.array(id).min(1, 'Upload the executed agreement').max(20),
});
const organisationFields = {
  legal_name: text(200).min(2, 'Enter the legal name'),
  trading_name: optional(200),
  country,
  registration_number: text(100).min(1, 'Enter the registration number'),
  sector: optional(200),
  registered_address: text(500).min(3, 'Enter the registered address'),
  trading_address: optional(500),
  tax_id: optional(100),
};
const anchorInput = z.object({ ...organisationFields, erp_system: optional(200) });
const funderInput = z.object({ ...organisationFields, funder_type: z.enum(['syndicate_fund', 'bank', 'dfi', 'private_credit', 'insurer_guarantor']), regulatory_status: text(200).min(2, 'Record the regulatory status'), licence_reference: optional(200), tax_status: optional(200), custodian_may_approve: z.boolean().default(false) });
const createInput = z.object({
  counterparty: z.enum(['ANCHOR', 'FUNDER']),
  agreement: agreementInput,
  organisation: z.record(z.string(), z.unknown()),
  // A funder organisation is held by its relationship owner's account, provisioned here (F1.5) and never sent anything yet.
  relationship_owner: z.object({ name: text(200).min(2), email, job_title: optional(200) }).optional(),
});

async function claimDocuments(ref: string, ids: string[], db: DB, buyerId?: string) {
  const unique = [...new Set(ids)];
  const docs = await rows('SELECT id,org_ref,archived_at,upload_status FROM documents WHERE id=ANY($1::bigint[])', [unique], db);
  requireCondition(docs.length === unique.length, 422, 'A selected document does not exist');
  for (const doc of docs) {
    requireCondition(doc.upload_status === 'stored' && !doc.archived_at, 422, 'A selected document is not available');
    requireCondition(!doc.org_ref || doc.org_ref === ref, 403, 'A selected document belongs to another organisation');
  }
  await rows(`UPDATE documents SET org_ref=$2${buyerId ? ',buyer_id=coalesce(buyer_id,$3::bigint)' : ''},updated_at=now() WHERE id=ANY($1::bigint[])`, buyerId ? [unique, ref, buyerId] : [unique, ref], db);
  return unique;
}
/** A1.2/F1.2: the same registration number in the same country is the same organisation, whatever its role. */
async function duplicate(countryCode: string, registration: string, db: DB, except?: string) {
  const [found] = await rows(`SELECT ref,name FROM (
      SELECT 'buyer-'||id AS ref,name FROM buyers WHERE upper(country)=$1 AND lower(trim(registration_number))=lower(trim($2))
      UNION ALL SELECT 'financier-'||user_id,name FROM financier_profiles WHERE upper(country)=$1 AND lower(trim(registration_number))=lower(trim($2))
      UNION ALL SELECT 'supplier-'||id,name FROM suppliers WHERE upper(country)=$1 AND lower(trim(registration_number))=lower(trim($2))
    ) existing WHERE ref IS DISTINCT FROM $3 LIMIT 1`, [countryCode, registration, except ?? null], db);
  return found ?? null;
}
async function createOrganisation(actor: Actor, body: unknown) {
  const input = createInput.parse(body);
  const agreement = input.agreement;
  requireCondition(agreement.executed_on <= today(), 422, 'The agreement execution date cannot be in the future');
  requireCondition(!agreement.effective_on || !agreement.expiry_on || agreement.expiry_on >= agreement.effective_on, 422, 'The agreement expiry cannot precede its effective date');
  const counterparty = input.counterparty;
  const org = (counterparty === 'ANCHOR' ? anchorInput : funderInput).parse(input.organisation) as z.infer<typeof anchorInput> & Partial<z.infer<typeof funderInput>>;
  if (counterparty === 'FUNDER') requireCondition(input.relationship_owner, 422, 'Name the funder’s relationship owner');
  return transaction(async db => {
    await requireOpsRole(actor, 'relationship_manager', db);
    const existing = await duplicate(org.country, org.registration_number, db);
    requireCondition(!existing, 409, `${existing?.name} is already on the platform with this registration number (${existing?.ref}). Open the existing record instead of creating a duplicate.`);
    let ref: string; let buyerId: string | undefined;
    if (counterparty === 'ANCHOR') {
      const [buyer] = await rows(`INSERT INTO buyers(name,legal_name,trading_name,registration_number,country,industry,registered_address,address,operating_address,tax_id,erp_system,onboarding_status,verification_status,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,'SETUP_IN_PROGRESS','pending',now(),now()) RETURNING *`,
        [org.trading_name ?? org.legal_name, org.legal_name, org.trading_name, org.registration_number, org.country, org.sector, org.registered_address, org.trading_address, org.tax_id, org.erp_system], db);
      ref = `buyer-${buyer.id}`; buyerId = String(buyer.id);
      await entityAudit(db, actor, 'buyers', String(buyer.id), 'created', null, buyer);
    } else {
      const owner = input.relationship_owner!;
      const [taken] = await rows('SELECT id FROM users WHERE lower(email)=$1', [owner.email], db);
      requireCondition(!taken, 409, 'An account with the relationship owner’s email already exists');
      const [user] = await rows(`INSERT INTO users(email,name,job_title,encrypted_password,role,jti,org_role,provisioning_status,created_at,updated_at)
        VALUES($1,$2,$3,'!provisioned',3,$4,'relationship_owner','PROVISIONED_NOT_ACTIVATED',now(),now()) RETURNING id`, [owner.email, owner.name, owner.job_title, randomUUID()], db);
      ref = `financier-${user.id}`;
      await rows('UPDATE users SET org_ref=$2 WHERE id=$1', [user.id, ref], db);
      await rows(`INSERT INTO financier_profiles(user_id,name,legal_name,trading_name,registration_number,country,industry,registered_address,operating_address,tax_id,funder_type,regulatory_status,licence_reference,tax_status,custodian_may_approve,institution_type,onboarding_status,verification_status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$11,'SETUP_IN_PROGRESS','pending')`,
        [user.id, org.trading_name ?? org.legal_name, org.legal_name, org.trading_name, org.registration_number, org.country, org.sector, org.registered_address, org.trading_address, org.tax_id, org.funder_type, org.regulatory_status, org.licence_reference, org.tax_status, org.custodian_may_approve ?? false], db);
      await entityAudit(db, actor, 'financers', String(user.id), 'created', null, { ...org, relationship_owner: owner.email });
    }
    const documents = await claimDocuments(ref, agreement.document_ids, db, buyerId);
    await rows(`INSERT INTO executed_agreements(org_ref,kind,version,reference,executed_on,effective_on,expiry_on,document_ids,captured_by) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8)`,
      [ref, counterparty === 'ANCHOR' ? 'commercial' : 'facility', agreement.reference, agreement.executed_on, agreement.effective_on ?? null, agreement.expiry_on ?? null, JSON.stringify(documents), actor.id], db);
    await startLifecycle(ref, counterparty, 'SETUP_IN_PROGRESS', actor, `Set up from executed agreement ${agreement.reference}`, db);
    await portalEvent(actor, 'organisation.setup_started', null, null, { org_ref: ref, record_id: ref, counterparty, agreement_reference: agreement.reference }, db);
    return { ref };
  });
}

type Org = { ref: string; counterparty: Counterparty; key: string; record: Row };
async function organisation(ref: string, db: DB, lock = false): Promise<Org> {
  requireCondition(refPattern.test(ref), 404, 'Organisation not found');
  const [kind, key] = ref.split('-');
  const [record] = kind === 'buyer'
    ? await rows(`SELECT * FROM buyers WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [key], db)
    : await rows(`SELECT * FROM financier_profiles WHERE user_id=$1${lock ? ' FOR UPDATE' : ''}`, [key], db);
  requireCondition(record, 404, 'Organisation not found');
  return { ref, counterparty: kind === 'buyer' ? 'ANCHOR' : 'FUNDER', key, record };
}
async function editable(ref: string, db: DB) {
  const state = await lifecycle(ref, db, true);
  requireCondition(state && !state.legacy, 409, 'This organisation was set up before the onboarding checklist; manage it from Organizations');
  requireCondition(EDITABLE_SETUP.includes(state.status), 409, `Set-up details are locked while the organisation is ${state.status.toLowerCase().replaceAll('_', ' ')}`);
  return state;
}
async function updateOrganisation(actor: Actor, ref: string, body: unknown) {
  return transaction(async db => {
    await requireOpsRole(actor, 'relationship_manager', db);
    const org = await organisation(ref, db, true);
    await editable(ref, db);
    const data = (org.counterparty === 'ANCHOR' ? anchorInput : funderInput).partial().strict().parse(body) as Row;
    const countryCode = data.country ?? org.record.country; const registration = data.registration_number ?? org.record.registration_number;
    const clash = await duplicate(countryCode, registration, db, ref);
    requireCondition(!clash, 409, `${clash?.name} is already on the platform with this registration number (${clash?.ref})`);
    const columns: Record<string, unknown> = { legal_name: data.legal_name, trading_name: data.trading_name, registration_number: data.registration_number, country: data.country, industry: data.sector, registered_address: data.registered_address, operating_address: data.trading_address, tax_id: data.tax_id, ...(org.counterparty === 'ANCHOR' ? { erp_system: data.erp_system } : { funder_type: data.funder_type, institution_type: data.funder_type, regulatory_status: data.regulatory_status, licence_reference: data.licence_reference, tax_status: data.tax_status, custodian_may_approve: data.custodian_may_approve }) };
    if (data.trading_name !== undefined || data.legal_name !== undefined) columns.name = data.trading_name ?? data.legal_name ?? undefined;
    const set = Object.entries(columns).filter(([, value]) => value !== undefined);
    requireCondition(set.length, 422, 'No changes were supplied');
    const [after] = await rows(`UPDATE ${org.counterparty === 'ANCHOR' ? 'buyers' : 'financier_profiles'} SET ${set.map(([key], i) => `"${key}"=$${i + 2}`).join(',')},updated_at=now() WHERE ${org.counterparty === 'ANCHOR' ? 'id' : 'user_id'}=$1 RETURNING *`, [org.key, ...set.map(([, value]) => value)], db);
    await entityAudit(db, actor, org.counterparty === 'ANCHOR' ? 'buyers' : 'financers', org.key, 'updated', org.record, after);
    await portalEvent(actor, 'organisation.setup_updated', null, null, { org_ref: ref, record_id: ref }, db);
  });
}

// ── named users (A1.3, F1.5) ────────────────────────────────────────────────
const userInput = z.object({ name: text(200).min(2, 'Enter the person’s full name'), email, job_title: optional(200), phone: optional(100), org_role: z.string(), approval_limit: z.union([z.string(), z.number()]).optional().transform(value => value === undefined || value === '' ? null : String(value)) });
async function people(org: Org, db: DB) {
  return rows(`SELECT id,name,email,job_title,contact_phone AS phone,org_role,provisioning_status,approval_limit,last_successful_login_at FROM users
    WHERE org_ref=$1 OR ${org.counterparty === 'ANCHOR' ? 'buyer_id=$2' : 'id=$2'} ORDER BY id`, [org.ref, org.key], db);
}
/** The documented user set must give the organisation every required role, held by different people (segregation of duties). */
export async function provisioningProblems(org: Org, db: DB): Promise<string[]> {
  const required = (await setting<Record<string, string[]>>('required_user_roles', db))?.[org.counterparty] ?? [];
  const list = (await people(org, db)).filter(u => u.provisioning_status !== 'DISABLED');
  const problems = required.filter(role => !list.some(u => u.org_role === role)).map(role => `Provision at least one ${ORG_ROLE_LABEL[role].toLowerCase()}`);
  if (org.counterparty === 'FUNDER') {
    if (list.some(u => u.org_role === 'credit_officer' && !(Number(u.approval_limit) > 0))) problems.push('Record each credit officer’s approval authority');
  }
  return problems;
}
async function provisionUser(actor: Actor, ref: string, body: unknown) {
  return transaction(async db => {
    await requireOpsRole(actor, 'relationship_manager', db);
    const org = await organisation(ref, db, true);
    const state = await lifecycle(ref, db, true);
    requireCondition(state && !state.legacy && !['DECLINED', 'CLOSED', 'SETUP_ABANDONED'].includes(state.status), 409, 'Users cannot be provisioned for this organisation');
    const data = userInput.parse(body);
    requireCondition(ORG_ROLES[org.counterparty].includes(data.org_role), 422, 'Choose a role this organisation’s users can hold');
    requireCondition(data.org_role !== 'relationship_owner', 422, 'A funder has one relationship owner, recorded at set-up');
    if (data.approval_limit !== null) requireCondition(/^\d+(\.\d{1,2})?$/.test(data.approval_limit) && Number(data.approval_limit) > 0, 422, 'Enter a positive approval authority');
    requireCondition(data.org_role === 'credit_officer' || data.approval_limit === null, 422, 'Approval authority applies to credit officers only');
    const [taken] = await rows('SELECT id FROM users WHERE lower(email)=$1', [data.email], db);
    requireCondition(!taken, 409, 'An account with this email already exists');
    const [user] = await rows(`INSERT INTO users(email,name,job_title,contact_phone,encrypted_password,role,buyer_id,jti,org_ref,org_role,provisioning_status,approval_limit,created_at,updated_at)
      VALUES($1,$2,$3,$4,'!provisioned',$5,$6,$7,$8,$9,'PROVISIONED_NOT_ACTIVATED',$10,now(),now()) RETURNING id`,
      [data.email, data.name, data.job_title, data.phone, org.counterparty === 'ANCHOR' ? 0 : 3, org.counterparty === 'ANCHOR' ? org.key : null, randomUUID(), ref, data.org_role, data.approval_limit], db);
    await portalEvent(actor, 'organisation.user_provisioned', null, null, { org_ref: ref, record_id: ref, user_id: user.id, org_role: data.org_role }, db);
    return { id: String(user.id) };
  });
}
async function changeUser(actor: Actor, ref: string, userId: string, method: string, body: unknown) {
  return transaction(async db => {
    await requireOpsRole(actor, 'relationship_manager', db);
    const org = await organisation(ref, db, true);
    const [user] = await rows('SELECT * FROM users WHERE id=$1 FOR UPDATE', [userId], db);
    requireCondition(user && (user.org_ref === ref || (org.counterparty === 'ANCHOR' && same(user.buyer_id, org.key))), 404, 'User not found');
    requireCondition(['PROVISIONED_NOT_ACTIVATED', 'INVITED'].includes(user.provisioning_status), 409, 'Activated users are managed from Users and access');
    if (method === 'DELETE') {
      requireCondition(!(org.counterparty === 'FUNDER' && same(user.id, org.key)), 409, 'The relationship owner holds the funder record and cannot be removed');
      await rows('DELETE FROM user_invitations WHERE user_id=$1', [userId], db);
      await rows('DELETE FROM users WHERE id=$1', [userId], db);
      await portalEvent(actor, 'organisation.user_removed', null, null, { org_ref: ref, record_id: ref, user_id: userId }, db);
      return { removed: true };
    }
    const data = userInput.partial().parse(body);
    if (data.org_role) {
      requireCondition(ORG_ROLES[org.counterparty].includes(data.org_role) && data.org_role !== 'relationship_owner' && user.org_role !== 'relationship_owner', 422, 'Choose a role this organisation’s users can hold');
    }
    const role = data.org_role ?? user.org_role;
    const limit = data.approval_limit !== undefined ? data.approval_limit : user.approval_limit;
    requireCondition(role === 'credit_officer' || limit === null, 422, 'Approval authority applies to credit officers only');
    await rows('UPDATE users SET name=coalesce($2,name),job_title=coalesce($3,job_title),contact_phone=coalesce($4,contact_phone),org_role=$5,approval_limit=$6,updated_at=now() WHERE id=$1', [userId, data.name ?? null, data.job_title ?? null, data.phone ?? null, role, limit], db);
    await portalEvent(actor, 'organisation.user_updated', null, null, { org_ref: ref, record_id: ref, user_id: userId, org_role: role }, db);
    return { updated: true };
  });
}

// ── signatories (A1.4, F1.4) and contacts (A1.5) ────────────────────────────
const signatoryInput = z.object({ name: text(200).min(2), title: optional(200), email: email.optional(), scope: text(2000).min(5, 'Describe what the signatory may authorise'), authority_limit: z.union([z.string(), z.number()]).optional().transform(value => value === undefined || value === '' ? null : String(value)), evidence_document_id: id.optional(), evidence_clause: optional(200) });
async function addSignatory(actor: Actor, ref: string, body: unknown) {
  return transaction(async db => {
    await requireOpsRole(actor, 'relationship_manager', db);
    const org = await organisation(ref, db, true);
    await editable(ref, db);
    const data = signatoryInput.parse(body);
    if (data.authority_limit !== null) requireCondition(/^\d+(\.\d{1,2})?$/.test(data.authority_limit), 422, 'Enter the authority limit as an amount');
    requireCondition(data.evidence_document_id || data.evidence_clause, 422, 'Link the document or clause evidencing the authority');
    if (data.evidence_document_id) await claimDocuments(ref, [data.evidence_document_id], db, org.counterparty === 'ANCHOR' ? org.key : undefined);
    const [row] = await rows('INSERT INTO authorised_signatories(org_ref,name,title,email,scope,authority_limit,evidence_document_id,evidence_clause,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id', [ref, data.name, data.title, data.email ?? null, data.scope, data.authority_limit, data.evidence_document_id ?? null, data.evidence_clause, actor.id], db);
    await portalEvent(actor, 'organisation.signatory_recorded', null, null, { org_ref: ref, record_id: ref, signatory_id: row.id }, db);
    return { id: String(row.id) };
  });
}
async function removeSignatory(actor: Actor, ref: string, signatoryId: string) {
  return transaction(async db => {
    await requireOpsRole(actor, 'relationship_manager', db);
    await organisation(ref, db, true);
    await editable(ref, db);
    const [row] = await rows('UPDATE authorised_signatories SET removed_at=now() WHERE id=$1 AND org_ref=$2 AND removed_at IS NULL RETURNING id', [signatoryId, ref], db);
    requireCondition(row, 404, 'Signatory not found');
    await portalEvent(actor, 'organisation.signatory_removed', null, null, { org_ref: ref, record_id: ref, signatory_id: signatoryId }, db);
    return { removed: true };
  });
}
const contactsInput = z.object({ contacts: z.array(z.object({ purpose: z.enum(['commercial', 'finance', 'it', 'operations']), name: text(200).min(2), email: email.optional(), phone: optional(100) })).max(4) });
async function saveContacts(actor: Actor, ref: string, body: unknown) {
  return transaction(async db => {
    await requireOpsRole(actor, 'relationship_manager', db);
    await organisation(ref, db, true);
    await editable(ref, db);
    const data = contactsInput.parse(body);
    requireCondition(new Set(data.contacts.map(c => c.purpose)).size === data.contacts.length, 422, 'Record one contact per purpose');
    for (const contact of data.contacts) requireCondition(contact.email || contact.phone, 422, 'Give each contact an email or a phone number');
    await rows('DELETE FROM organisation_contacts WHERE org_ref=$1', [ref], db);
    for (const contact of data.contacts) await rows('INSERT INTO organisation_contacts(org_ref,purpose,name,email,phone,updated_by) VALUES($1,$2,$3,$4,$5,$6)', [ref, contact.purpose, contact.name, contact.email ?? null, contact.phone, actor.id], db);
    await portalEvent(actor, 'organisation.contacts_recorded', null, null, { org_ref: ref, record_id: ref }, db);
    return { saved: true };
  });
}
/** Contacts the anchor's notifications route to (A1.5); the funder's relationship owner is its commercial contact. */
export function requiredContacts(counterparty: Counterparty) { return counterparty === 'ANCHOR' ? ['commercial', 'finance', 'it'] : ['commercial', 'operations']; }

// ── abandon / reopen ────────────────────────────────────────────────────────
async function abandon(actor: Actor, ref: string, body: Row, reopen: boolean) {
  const reason = z.string().trim().min(10, 'State the reason (at least 10 characters)').max(2000).parse(body.reason);
  return transaction(async db => {
    await requireOpsRole(actor, 'relationship_manager', db);
    await organisation(ref, db, true);
    const state = await transition(ref, reopen ? 'SETUP_IN_PROGRESS' : 'SETUP_ABANDONED', actor, reason, db);
    await portalEvent(actor, reopen ? 'organisation.setup_reopened' : 'organisation.setup_abandoned', reason, null, { org_ref: ref, record_id: ref }, db);
    return { status: state.status };
  });
}

// ── read models ─────────────────────────────────────────────────────────────
async function detail(ref: string) {
  return transaction(async db => {
    const org = await organisation(ref, db);
    const state = await lifecycle(ref, db);
    const agreements = await rows('SELECT id,kind,version,reference,executed_on,effective_on,expiry_on,document_ids,status,created_at FROM executed_agreements WHERE org_ref=$1 ORDER BY version DESC', [ref], db);
    const documentIds = [...new Set(agreements.flatMap(a => a.document_ids ?? []))];
    const documents = await rows('SELECT id,file_name,size_bytes,created_at FROM documents WHERE id=ANY($1::bigint[])', [documentIds], db);
    const users = await people(org, db);
    const signatories = await rows('SELECT s.id,s.name,s.title,s.email,s.scope,s.authority_limit,s.evidence_clause,s.evidence_document_id,d.file_name AS evidence_file FROM authorised_signatories s LEFT JOIN documents d ON d.id=s.evidence_document_id WHERE s.org_ref=$1 AND s.removed_at IS NULL ORDER BY s.id', [ref], db);
    const contacts = await rows('SELECT purpose,name,email,phone FROM organisation_contacts WHERE org_ref=$1', [ref], db);
    const missingContacts = requiredContacts(org.counterparty).filter(purpose => !contacts.some(c => c.purpose === purpose));
    // What stands between this record and compliance review (SRS "who is holding the process up").
    const setupProblems = [
      ...await provisioningProblems(org, db),
      ...(signatories.length ? [] : ['Record at least one authorised signatory']),
      ...missingContacts.map(purpose => `Record the ${purpose === 'it' ? 'IT (data delivery)' : purpose} contact`),
    ];
    const r = org.record;
    return {
      ref, counterparty: org.counterparty, name: r.name, status: state?.status ?? 'ACTIVE', legacy: state?.legacy ?? true,
      profile: { legal_name: r.legal_name, trading_name: r.trading_name, country: r.country, registration_number: r.registration_number, sector: r.industry, registered_address: r.registered_address, trading_address: r.operating_address, tax_id: r.tax_id, erp_system: r.erp_system ?? null, funder_type: r.funder_type ?? null, regulatory_status: r.regulatory_status ?? null, licence_reference: r.licence_reference ?? null, tax_status: r.tax_status ?? null, custodian_may_approve: r.custodian_may_approve ?? null },
      agreements: agreements.map(a => ({ ...a, documents: documents.filter(d => (a.document_ids ?? []).map(String).includes(String(d.id))) })),
      users, signatories, contacts, setup_problems: setupProblems, history: await history(ref, db),
      editable: !!state && !state.legacy && EDITABLE_SETUP.includes(state.status),
    };
  });
}
async function overview() {
  return rows(`SELECT l.org_ref AS ref,l.counterparty,l.status,l.legacy,l.updated_at,coalesce(b.name,f.name) AS name,
      (SELECT reference FROM executed_agreements a WHERE a.org_ref=l.org_ref ORDER BY version DESC LIMIT 1) AS agreement_reference,
      (SELECT count(*)::int FROM users u WHERE (u.org_ref=l.org_ref OR (l.counterparty='ANCHOR' AND u.buyer_id=b.id)) AND u.provisioning_status<>'DISABLED') AS users
    FROM organisation_lifecycle l
    LEFT JOIN buyers b ON l.counterparty='ANCHOR' AND l.org_ref='buyer-'||b.id
    LEFT JOIN financier_profiles f ON l.counterparty='FUNDER' AND l.org_ref='financier-'||f.user_id
    WHERE l.counterparty IN ('ANCHOR','FUNDER') ORDER BY l.legacy, l.updated_at DESC`);
}

// ── Syndicate team roles (super administrator) ───────────────────────────────
async function team() {
  const operators = await rows("SELECT id,name,email,ops_roles,super_admin,disabled_at FROM users WHERE role=2 ORDER BY name NULLS LAST,email");
  return { roles: OPS_ROLES.map(role => ({ key: role, label: OPS_ROLE_LABEL[role] })), operators: operators.map(o => ({ ...o, all_roles: o.ops_roles === null })) };
}
async function assignRoles(actor: Actor, userId: string, body: unknown) {
  requireCondition(await isSuperAdmin(actor), 403, 'Only the super administrator assigns Syndicate roles');
  const data = opsRolesInput.parse(body);
  return transaction(async db => {
    const [user] = await rows('SELECT id,ops_roles FROM users WHERE id=$1 AND role=2 FOR UPDATE', [userId], db);
    requireCondition(user, 404, 'Operator not found');
    await rows('UPDATE users SET ops_roles=$2,updated_at=now() WHERE id=$1', [userId, data.roles], db);
    await portalEvent(actor, 'operator.roles_assigned', null, null, { record_id: userId, before: user.ops_roles, after: data.roles }, db);
    return { id: userId, ops_roles: data.roles };
  });
}

/** portal/setup … — Syndicate only. */
export async function setupRequest(actor: Actor, method: string, path: string[], body: Row): Promise<{ status?: number; data?: unknown }> {
  requireCondition(actor.role === 'platform_ops' && !actor.delegation, 403, 'Organisations are set up by INVOX operations');
  const [, , first, second, third] = path;
  if (!first && method === 'GET') return { data: await overview() };
  if (!first && method === 'POST') return { data: await createOrganisation(actor, body), status: 201 };
  if (first === 'team' && !second && method === 'GET') return { data: await team() };
  if (first === 'team' && second && third === 'roles' && method === 'PUT') return { data: await assignRoles(actor, id.parse(second), body) };
  const ref = String(first);
  if (!second && method === 'GET') return { data: await detail(ref) };
  if (!second && method === 'PATCH') { await updateOrganisation(actor, ref, body); return { data: await detail(ref) }; }
  if (second === 'users' && !third && method === 'POST') return { data: await provisionUser(actor, ref, body), status: 201 };
  if (second === 'users' && third && ['PATCH', 'DELETE'].includes(method)) return { data: await changeUser(actor, ref, id.parse(third), method, body) };
  if (second === 'signatories' && !third && method === 'POST') return { data: await addSignatory(actor, ref, body), status: 201 };
  if (second === 'signatories' && third && method === 'DELETE') return { data: await removeSignatory(actor, ref, id.parse(third)) };
  if (second === 'contacts' && method === 'PUT') return { data: await saveContacts(actor, ref, body) };
  if (second === 'abandon' && method === 'POST') return { data: await abandon(actor, ref, body, false) };
  if (second === 'reopen' && method === 'POST') return { data: await abandon(actor, ref, body, true) };
  throw new ApiError(404, 'Set-up endpoint not found');
}
