import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { type Actor, requireRole, revokeSessions } from './auth';
import { rows, transaction, type DB, type Row } from './db';
import { ApiError, requireCondition } from './errors';
import { id, email } from './validation';
import { fieldCatalog, fieldSchema, coreSchema, databaseValues, rejectManagedFields, validateFieldReferences, entityAudit } from './fields';
import { resourceRequest, invoiceList, lockOperatorSet } from './resources';
import { assertFresh } from './context';
import { portalEvent, notify } from './portal-support';
import { cents } from './money';
type Module = {
    key: string;
    title: string;
    group: string;
    roles: string[];
    entity?: string;
    readOnly?: boolean;
    description: string;
};
export const workflowModules: Module[] = [
    { key: 'buyers', title: 'Buyer organisations', group: 'Participants', roles: ['platform_ops'], entity: 'buyers', description: 'Create and maintain buyer profiles and administrator accounts.' },
    { key: 'suppliers', title: 'Supplier organisations', group: 'Participants', roles: ['platform_ops'], entity: 'suppliers', description: 'Maintain supplier profiles, invitations and archive status.' },
    { key: 'financers', title: 'Financier organisations', group: 'Participants', roles: ['platform_ops'], entity: 'financers', description: 'Manage institutional profiles and their login accounts.' },
    { key: 'users', title: 'Users and access', group: 'Participants', roles: ['platform_ops', 'buyer_admin'], entity: 'users', description: 'Create, edit and disable accounts within your organisation.' },
    { key: 'supplier_relationships', title: 'Supplier relationships', group: 'Participants', roles: ['buyer_admin', 'platform_ops'], description: 'Manage programme membership and relationship contacts without altering another company’s legal profile.' },
    { key: 'programmes', title: 'Programmes', group: 'Trade and approvals', roles: ['platform_ops', 'buyer_admin'], entity: 'programmes', description: 'Configure complete commercial terms, activate, pause and archive programmes.' },
    { key: 'invoices', title: 'Invoices', group: 'Trade and approvals', roles: ['platform_ops', 'buyer_admin', 'supplier_user', 'financer'], entity: 'invoices', description: 'Save incomplete drafts, complete their fields, obtain supplier approval and manage their lifecycle.' },
    { key: 'bids', title: 'Financing offers', group: 'Financing', roles: ['platform_ops', 'financer'], description: 'Review your pricing, delete unsubmitted drafts or withdraw offers before acceptance.' },
    { key: 'tenders', title: 'Financing tenders', group: 'Financing', roles: ['platform_ops', 'buyer_admin', 'financer'], description: 'Manage invitations and deadlines; cancel unawarded tenders with an audit reason.' },
    { key: 'financing_requests', title: 'Early payment requests', group: 'Financing', roles: ['platform_ops', 'supplier_user', 'buyer_admin'], entity: 'financing_requests', description: 'Request financing against approved eligible invoices and track the buyer’s response.' },
    { key: 'mandate_versions', title: 'Financier mandates', group: 'Financing', roles: ['platform_ops', 'financer'], entity: 'mandate_versions', description: 'Draft, submit, independently review and acknowledge mandate terms.' },
    { key: 'limits', title: 'Limits', group: 'Financing', roles: ['platform_ops'], entity: 'limits', description: 'Record scoped limits and approve effective-dated configurations independently.' },
    { key: 'conditions_precedent', title: 'Conditions precedent', group: 'Trade and approvals', roles: ['platform_ops', 'buyer_admin'], entity: 'conditions_precedent', description: 'Track programme conditions, evidence and independently recorded satisfaction.' },
    { key: 'agreements', title: 'Financing agreements', group: 'Settlement', roles: ['platform_ops', 'buyer_admin', 'supplier_user', 'financer'], readOnly: true, entity: 'agreements', description: 'View contractual evidence. Propose and independently verify execution from the related invoice.' },
    { key: 'fundings', title: 'Disbursements', group: 'Settlement', roles: ['platform_ops', 'financer', 'supplier_user', 'buyer_admin'], readOnly: true, entity: 'fundings', description: 'View recorded and verified disbursements. Record bank evidence from the invoice.' },
    { key: 'repayments', title: 'Repayment receipts and reversals', group: 'Settlement', roles: ['platform_ops', 'buyer_admin', 'financer', 'supplier_user'], readOnly: true, entity: 'repayments', description: 'View receipts and reversals; financial corrections remain separate independently verified events.' },
    { key: 'positions', title: 'Outstanding positions', group: 'Settlement', roles: ['platform_ops', 'buyer_admin', 'financer', 'supplier_user'], readOnly: true, description: 'A single derived position per funded invoice, separated by currency.' },
    { key: 'ledger', title: 'Ledger journals', group: 'Settlement', roles: ['platform_ops'], readOnly: true, description: 'Read immutable balanced administered-obligation journals and lines.' },
    { key: 'reconciliation_cases', title: 'Reconciliation cases', group: 'Settlement', roles: ['platform_ops'], entity: 'reconciliation_cases', description: 'Assign and resolve manual reconciliation cases without rewriting bank receipts or ledger balances.' },
    { key: 'documents', title: 'Documents', group: 'Evidence and operations', roles: ['platform_ops', 'buyer_admin', 'supplier_user', 'financer'], description: 'Upload private evidence, download authorised documents, and maintain unreferenced metadata.' },
    { key: 'exceptions', title: 'Operational exceptions', group: 'Evidence and operations', roles: ['platform_ops'], description: 'Create, assign and resolve operational investigations with reasons.' },
];
const same = (a: unknown, b: unknown) => String(a) === String(b);
const reasonSchema = z.string().trim().min(10, 'Provide a reason of at least 10 characters').max(4000);
const currencies = z.enum(['GHS', 'USD', 'EUR', 'NGN', 'KES']);
const ownerRole = (actor: Actor) => ['platform_ops', 'buyer_admin'].includes(actor.role);
const rawInput = (body: Row) => z.record(z.string(), z.unknown()).parse(body.record ?? body);
const tableFor = (entity: string) => entity === 'tenders' ? 'financing_tenders' : entity === 'supplier_relationships' ? 'portal_supplier_relationships' : entity === 'financers' ? 'financier_profiles' : entity === 'agreements' ? 'financing_agreements' : entity;
async function save(table: string, data: Row, db: DB, recordId?: string) {
    const keys = Object.keys(data);
    requireCondition(keys.length, 422, 'No editable fields were supplied');
    if (recordId)
        return (await rows(`UPDATE "${table}" SET ${keys.map((k, i) => '"' + k + '"=$' + (i + 2)).join(',')},updated_at=now() WHERE id=$1 RETURNING *`, [recordId, ...Object.values(data)], db))[0];
    return (await rows(`INSERT INTO "${table}" (${keys.map(k => '"' + k + '"').join(',')}) VALUES(${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, Object.values(data), db))[0];
}
async function invoice(actor: Actor, invoiceId: string, db: DB, lock = false) {
    const [record] = await rows(`SELECT i.*,p.buyer_id,p.status AS programme_status,p.currency AS programme_currency,p.archived_at AS programme_archived_at,p.maximum_tenor_days,p.maturity_days,s.user_id AS supplier_user_id,s.archived_at AS supplier_archived_at FROM invoices i JOIN programmes p ON p.id=i.programme_id JOIN suppliers s ON s.id=i.supplier_id WHERE i.id=$1 ${lock ? 'FOR UPDATE OF i' : ''}`, [invoiceId], db);
    requireCondition(record, 404, 'Invoice not found');
    requireCondition(actor.role === 'platform_ops' || actor.role === 'buyer_admin' && same(record.buyer_id, actor.buyer_id) || actor.role === 'supplier_user' && same(record.supplier_user_id, actor.id) || actor.role === 'financer' && (await rows('SELECT id FROM bids WHERE invoice_id=$1 AND financer_id=$2', [invoiceId, actor.id], db)).length, 403, 'Invoice is outside your organisation');
    return record;
}
async function programme(actor: Actor, programmeId: string, db: DB, lock = false) {
    const [record] = await rows(`SELECT * FROM programmes WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [programmeId], db);
    requireCondition(record, 404, 'Programme not found');
    requireCondition(actor.role === 'platform_ops' || actor.role === 'buyer_admin' && same(record.buyer_id, actor.buyer_id), 403, 'Programme is outside your organisation');
    return record;
}
async function invoiceLocked(record: Row, db: DB) {
    return ['funded', 'repaid'].includes(record.status) || !!record.financial_review_required || (await rows('SELECT id FROM bids WHERE invoice_id=$1 AND (status=1 OR portal_state IS DISTINCT FROM $2) UNION ALL SELECT id FROM financing_agreements WHERE invoice_id=$1 LIMIT 1', [record.id, 'WITHDRAWN'], db)).length > 0;
}
function draftSchema(entity: string, partial = false) {
    const schema = fieldSchema(entity, partial, { optional: true, exclude: ['status'] });
    return schema;
}
function withoutBlankRequired(entity: string, input: Row) { const data = { ...input }; for (const field of fieldCatalog[entity].fields)
    if (field.required && (data[field.key] === '' || data[field.key] === null))
        delete data[field.key]; return data; }
export async function validateInvoiceSubmission(actor: Actor, record: Row, db: DB) {
    requireCondition(!record.deleted_at && record.status === 'draft', 409, 'Only an existing draft can be submitted');
    coreSchema('invoices').parse(record);
    requireCondition(record.programme_status === 'active' && !record.programme_archived_at, 409, 'Activate the programme before submitting invoices');
    requireCondition(!record.supplier_archived_at, 409, 'The supplier is archived');
    const [p] = await rows('SELECT p.*,b.archived_at AS buyer_archived_at FROM programmes p JOIN buyers b ON b.id=p.buyer_id WHERE p.id=$1', [record.programme_id], db);
    requireCondition(p && !p.buyer_archived_at, 409, 'Buyer organisation is archived');
    const today = new Date().toISOString().slice(0, 10);
    requireCondition((!p.effective_from || p.effective_from <= today) && (!p.effective_to || p.effective_to >= today), 409, 'Programme is outside its effective dates');
    requireCondition(!(await rows("SELECT id FROM conditions_precedent WHERE programme_id=$1 AND mandatory AND status<>'satisfied' LIMIT 1", [record.programme_id], db)).length, 409, 'Mandatory conditions precedent remain unsatisfied');
    requireCondition((await rows("SELECT 1 FROM portal_supplier_relationships WHERE buyer_id=$1 AND supplier_id=$2 AND status='active'", [p.buyer_id, record.supplier_id], db)).length, 409, 'Supplier relationship is archived or missing');
    requireCondition(record.currency === record.programme_currency, 422, 'Invoice currency must match the programme currency');
    requireCondition(record.due_date >= record.issue_date, 422, 'Due date cannot precede issue date');
    requireCondition(record.due_date >= new Date().toISOString().slice(0, 10), 422, 'A matured invoice cannot be submitted for financing approval');
    const days = Math.ceil((Date.parse(record.due_date) - Date.parse(record.issue_date)) / 86400000);
    requireCondition(!record.maximum_tenor_days || days <= record.maximum_tenor_days, 422, 'Invoice tenor exceeds the programme maximum');
    await validateFieldReferences('invoices', record, actor, db);
}
function moduleDefinition(actor: Actor, key: string) { const definition = workflowModules.find(m => m.key === key && m.roles.includes(actor.role)); requireCondition(definition, 403, 'This module is not available to your role'); return definition; }
async function actionsFor(entity: string, record: Row, actor: Actor, db: DB) {
    if (['agreements', 'fundings', 'repayments', 'positions', 'ledger'].includes(entity))
        return { view: true, edit: false, delete: false, reason: 'Financial evidence and positions are immutable. Use the invoice evidence and reversal workflow.' };
    if (entity === 'invoices') {
        const locked = await invoiceLocked(record, db);
        const editing = ownerRole(actor) && !locked && record.status === 'draft' && !['pending', 'approved'].includes(record.invoice_approval_status) && !record.deleted_at;
        return { view: true, edit: editing, delete: editing, restore: ownerRole(actor) && !!record.deleted_at, submit: editing, withdraw: ownerRole(actor) && !locked && ['pending', 'approved'].includes(record.invoice_approval_status), cancel: ownerRole(actor) && !locked && !record.deleted_at && !['cancelled', 'funded', 'repaid'].includes(record.status), reason: locked ? (record.financial_review_required ? 'This invoice needs operations to reconcile its earlier financing records before it can change.' : ['funded', 'repaid'].includes(record.status) ? 'Terms are fixed because this invoice has been financed.' : record.status === 'tender' ? 'Terms are fixed while the invoice is open for financing. Cancel the tender to make changes.' : 'Terms are fixed because financiers have made offers on this invoice.') : record.invoice_approval_status === 'pending' || record.invoice_approval_status === 'approved' ? 'Withdraw the submission/approval before changing its terms.' : null };
    }
    if (entity === 'programmes') {
        const dependencies = (await rows('SELECT id FROM invoices WHERE programme_id=$1 AND deleted_at IS NULL LIMIT 1', [record.id], db)).length > 0;
        const economicLock = (await rows("SELECT i.id FROM invoices i LEFT JOIN bids b ON b.invoice_id=i.id AND b.status=1 WHERE i.programme_id=$1 AND (i.status IN ('tender','funded','repaid') OR b.id IS NOT NULL) LIMIT 1", [record.id], db)).length > 0;
        return { edit: ownerRole(actor) && !record.archived_at && !economicLock && ['draft', 'paused'].includes(record.status ?? 'draft'), delete: ownerRole(actor) && !dependencies && (record.status ?? 'draft') === 'draft' && !record.archived_at, submit: ownerRole(actor) && !record.archived_at && ['draft', 'paused'].includes(record.status ?? 'draft'), activate: actor.role === 'platform_ops' && !record.archived_at && record.status === 'pending_review' && !same(record.created_by, actor.id) && !same(record.last_modified_by, actor.id) && !same(record.configured_by, actor.id), pause: ownerRole(actor) && record.status === 'active', archive: ownerRole(actor) && !record.archived_at, restore: ownerRole(actor) && !!record.archived_at, reason: economicLock ? 'Economic terms are locked by financing activity. Pause the programme to prevent new submissions.' : null };
    }
    if (entity === 'bids')
        return { edit: false, delete: actor.role === 'financer' && same(record.financer_id, actor.id) && record.status === 0 && record.portal_state === 'DRAFT', withdraw: actor.role === 'financer' && same(record.financer_id, actor.id) && record.status === 0 && record.portal_state === 'SUBMITTED', reason: 'Edit pricing from the invited opportunity. Accepted offers are retained with their financial history.' };
    if (entity === 'tenders') {
        const awarded = record.status === 'awarded' || record.accepted_bid_id;
        return { edit: ownerRole(actor) && record.status === 'open' && !awarded, cancel: ownerRole(actor) && record.status === 'open' && !awarded, delete: false, reason: awarded ? 'An awarded tender is retained with its accepted offer.' : null };
    }
    if (entity === 'documents') {
        const references = Object.values(fieldCatalog).flatMap(definition => definition.fields.filter(field => field.reference === 'documents' && field.type === 'reference').map(field => `SELECT id FROM ${tableFor(definition.key)} WHERE "${field.key}"=$2`));
        const linked = (await rows(`SELECT id FROM invoices WHERE supporting_documents @> $1::jsonb UNION ALL ${references.join(' UNION ALL ')} LIMIT 1`, [JSON.stringify([{ document_id: String(record.id) }]), record.id], db)).length > 0;
        const owned = actor.role === 'platform_ops' || same(record.uploaded_by, actor.id);
        return { edit: owned && !record.archived_at, delete: owned && !linked && !record.legal_hold && (!record.retention_until || record.retention_until < new Date().toISOString().slice(0, 10)), reason: linked ? 'This evidence is referenced by a transaction and cannot be removed.' : record.legal_hold ? 'A legal hold prevents deletion.' : null };
    }
    if (['buyers', 'suppliers', 'financers'].includes(entity))
        return { edit: actor.role === 'platform_ops' && !record.archived_at, delete: false, archive: actor.role === 'platform_ops' && !record.archived_at, restore: actor.role === 'platform_ops' && !!record.archived_at, reason: 'Archive organisations to preserve their transactions and audit history.' };
    if (entity === 'users')
        return { edit: !record.disabled_at, delete: !same(record.id, actor.id) && !record.disabled_at, restore: !!record.disabled_at, reason: 'Removing access disables the account and revokes its sessions; historical records remain.' };
    if (entity === 'supplier_relationships')
        return { edit: ownerRole(actor) && record.status === 'active', archive: ownerRole(actor) && record.status === 'active', restore: ownerRole(actor) && record.status === 'archived' };
    if (entity === 'exceptions')
        return { edit: actor.role === 'platform_ops' && record.status === 'OPEN', resolve: actor.role === 'platform_ops' && record.status === 'OPEN', delete: false };
    const draft = ['draft', 'open', 'pending'].includes(record.status ?? 'draft');
    const own = actor.role === 'platform_ops' || same(record.created_by, actor.id);
    return { edit: draft && own, delete: draft && own, submit: record.status === 'draft' && own, approve: actor.role === 'platform_ops' && record.status === 'pending_review' && !same(record.created_by, actor.id) && !same(record.last_modified_by, actor.id), accept: entity === 'mandate_versions' && actor.role === 'financer' && same(record.financier_id, actor.id) && record.status === 'pending_acceptance', withdraw: entity === 'financing_requests' && ['draft', 'submitted'].includes(record.status) && own, review: entity === 'financing_requests' && ownerRole(actor) && record.status === 'submitted', decline: entity === 'financing_requests' && ownerRole(actor) && record.status === 'submitted', resolve: entity === 'reconciliation_cases' && record.status === 'open' && actor.role === 'platform_ops', satisfy: entity === 'conditions_precedent' && record.status === 'pending' && actor.role === 'platform_ops' && !same(record.created_by, actor.id) && !same(record.last_modified_by, actor.id), reason: !draft ? 'Submitted or released records are locked; use the available workflow action.' : null };
}
/** The caller's buyer organisation. Buyer roles without an active membership are refused, never widened (F01). */
function tenantBuyer(actor: Actor): string {
    requireCondition(actor.role === 'buyer_admin' && actor.buyer_id, 403, 'Your account is not linked to an active organisation');
    return actor.buyer_id;
}
async function listRecords(entity: string, actor: Actor, db: DB, recordId?: string, includeDeleted = false): Promise<Row[]> {
    let records: Row[] = [];
    if (['buyers', 'suppliers', 'financers', 'users'].includes(entity)) {
        if (entity === 'users' && actor.role === 'buyer_admin') {
            records = (await rows('SELECT id,email,name,job_title,contact_phone,country,preferred_language,timezone,recert_cycle,disabled_at,role,buyer_id,created_at,updated_at FROM users WHERE buyer_id=$1', [actor.buyer_id], db)).map(r => ({ ...r, role: ['buyer_admin', 'supplier_user', 'platform_ops', 'financer'][r.role] }));
        }
        else {
            requireRole(actor, 'platform_ops');
            const result = await resourceRequest(actor, 'GET', recordId ? [entity, recordId] : [entity]);
            records = recordId ? [result.data as Row] : result.data as Row[];
            const key = entity === 'financers' ? 'user_id' : 'id';
            const states = await rows(`SELECT ${key} AS id,${entity === 'users' ? 'disabled_at' : 'archived_at'} FROM ${tableFor(entity)} WHERE ${key}=ANY($1::bigint[])`, [records.map(r => r.id)], db);
            for (const record of records)
                Object.assign(record, Object.fromEntries(Object.entries(states.find(state => same(state.id, record.id)) ?? {}).filter(([k]) => k !== 'id')));
        }
    }
    else if (entity === 'programmes') {
        // Operations and tenant queries are separate statements; a missing tenant is never a wildcard (F01).
        const filter = recordId ? ' AND id=$2' : '';
        records = actor.role === 'platform_ops'
            ? await rows(`SELECT * FROM programmes WHERE TRUE${recordId ? ' AND id=$1' : ''} ORDER BY id DESC`, recordId ? [recordId] : [], db)
            : await rows(`SELECT * FROM programmes WHERE buyer_id=$1${filter} ORDER BY id DESC`, [tenantBuyer(actor), ...(recordId ? [recordId] : [])], db);
        const ids = records.map(r => r.id);
        const suppliers = await rows('SELECT programme_id,supplier_id FROM portal_programme_suppliers WHERE programme_id=ANY($1::bigint[])', [ids], db);
        const financiers = await rows('SELECT programme_id,financer_id FROM portal_programme_financiers WHERE programme_id=ANY($1::bigint[])', [ids], db);
        for (const r of records) {
            r.supplier_ids = suppliers.filter(m => same(m.programme_id, r.id)).map(m => m.supplier_id);
            r.financier_ids = financiers.filter(m => same(m.programme_id, r.id)).map(m => m.financer_id);
        }
    }
    else if (entity === 'supplier_relationships') {
        const select = 'SELECT r.*,s.name,s.country,s.registration_number,s.email AS supplier_email,s.archived_at FROM portal_supplier_relationships r JOIN suppliers s ON s.id=r.supplier_id';
        records = actor.role === 'platform_ops'
            ? await rows(`${select} WHERE TRUE${recordId ? ' AND r.id=$1' : ''} ORDER BY s.name`, recordId ? [recordId] : [], db)
            : await rows(`${select} WHERE r.buyer_id=$1${recordId ? ' AND r.id=$2' : ''} ORDER BY s.name`, [tenantBuyer(actor), ...(recordId ? [recordId] : [])], db);
        const links = await rows('SELECT ps.programme_id,ps.supplier_id,p.buyer_id FROM portal_programme_suppliers ps JOIN programmes p ON p.id=ps.programme_id WHERE ps.supplier_id=ANY($1::bigint[])', [records.map(r => r.supplier_id)], db);
        for (const r of records)
            r.programme_ids = links.filter(l => same(l.supplier_id, r.supplier_id) && same(l.buyer_id, r.buyer_id)).map(l => l.programme_id);
    }
    else {
        const scoped = entity === 'invoices' ? await invoiceList(actor, undefined, undefined, db, includeDeleted) : await invoiceList(actor, undefined, undefined, db);
        const invoiceIds = scoped.map(i => i.id);
        if (entity === 'invoices')
            records = scoped;
        else if (['agreements', 'fundings', 'repayments', 'positions'].includes(entity)) {
            let ids = invoiceIds;
            if (actor.role === 'financer')
                ids = (await rows('SELECT invoice_id FROM bids WHERE invoice_id=ANY($1::bigint[]) AND financer_id=$2 AND status=1', [ids, actor.id], db)).map(b => b.invoice_id);
            records = await rows(`SELECT * FROM ${entity === 'positions' ? 'financial_positions' : tableFor(entity)} WHERE invoice_id=ANY($1::bigint[]) ORDER BY ${entity === 'positions' ? 'invoice_id' : 'id'} DESC`, [ids], db);
            if (entity === 'positions')
                records = records.map(r => ({ ...r, id: r.invoice_id }));
        }
        else if (entity === 'bids')
            records = await rows('SELECT b.*,t.id AS tender_id FROM bids b LEFT JOIN financing_tenders t ON t.invoice_id=b.invoice_id WHERE $1 OR b.financer_id=$2 ORDER BY b.id DESC', [actor.role === 'platform_ops', actor.id], db);
        else if (entity === 'ledger')
            records = await rows("SELECT j.*,coalesce((SELECT jsonb_agg(jsonb_build_object('account',l.account_code,'side',l.side,'amount',l.amount)) FROM ledger_lines l WHERE l.journal_id=j.id),'[]'::jsonb) AS lines FROM ledger_journals j ORDER BY j.id DESC LIMIT 250", [], db);
        else if (entity === 'tenders')
            records = await rows('SELECT * FROM financing_tenders WHERE invoice_id=ANY($1::bigint[]) ORDER BY id DESC', [invoiceIds], db);
        else if (entity === 'documents')
            records = await rows(`SELECT id,file_name,category,mime_type,size_bytes,sha256,invoice_id,buyer_id,supplier_id,legal_hold,retention_until,scan_status,upload_status,uploaded_by,archived_at,created_at,updated_at FROM documents WHERE $1 OR uploaded_by=$2 OR buyer_id=$3 OR invoice_id=ANY($4::bigint[]) OR EXISTS(SELECT 1 FROM invoices i,jsonb_array_elements(coalesce(i.supporting_documents,'[]'::jsonb)) d WHERE i.id=ANY($4::bigint[]) AND d->>'document_id'=documents.id::text) ORDER BY id DESC LIMIT 250`, [actor.role === 'platform_ops', actor.id, actor.role === 'buyer_admin' ? actor.buyer_id : null, invoiceIds], db);
        else if (entity === 'financing_requests')
            records = await rows('SELECT * FROM financing_requests WHERE $1 OR invoice_id=ANY($2::bigint[]) ORDER BY id DESC', [actor.role === 'platform_ops', invoiceIds], db);
        else if (entity === 'mandate_versions')
            records = await rows('SELECT * FROM mandate_versions WHERE $1 OR financier_id=$2 ORDER BY id DESC', [actor.role === 'platform_ops', actor.id], db);
        else if (entity === 'conditions_precedent')
            records = actor.role === 'platform_ops' ? await rows('SELECT c.* FROM conditions_precedent c ORDER BY c.id DESC', [], db)
                : await rows('SELECT c.* FROM conditions_precedent c JOIN programmes p ON p.id=c.programme_id WHERE p.buyer_id=$1 ORDER BY c.id DESC', [tenantBuyer(actor)], db);
        else if (entity === 'exceptions')
            records = await rows('SELECT * FROM portal_exceptions ORDER BY id DESC LIMIT 250', [], db);
        else
            records = await rows(`SELECT * FROM "${entity}" ORDER BY id DESC LIMIT 250`, [], db);
    }
    if (recordId)
        records = records.filter(r => same(r.id, recordId));
    else if (!includeDeleted)
        records = records.filter(r => !r.deleted_at && !r.archived_at && !r.disabled_at && (entity !== 'supplier_relationships' || r.status !== 'archived'));
    return records;
}
async function partners(record: Row, data: Row, actor: Actor, db: DB) {
    if (data.supplier_ids !== undefined) {
        const ids = z.array(id).max(250).parse(data.supplier_ids);
        for (const supplier of ids) {
            const [exists] = await rows('SELECT id FROM suppliers WHERE id=$1 AND archived_at IS NULL', [supplier], db);
            requireCondition(exists, 422, 'Supplier is missing or archived');
            if (actor.role !== 'platform_ops')
                requireCondition((await rows('SELECT 1 FROM portal_supplier_relationships WHERE buyer_id=$1 AND supplier_id=$2 AND status=$3', [record.buyer_id, supplier, 'active'], db)).length, 403, 'Invite this supplier before adding it to a programme');
        }
        const old = await rows('SELECT supplier_id FROM portal_programme_suppliers WHERE programme_id=$1', [record.id], db);
        for (const removed of old.filter(r => !ids.includes(String(r.supplier_id))))
            requireCondition(!(await rows("SELECT id FROM invoices WHERE programme_id=$1 AND supplier_id=$2 AND deleted_at IS NULL AND status NOT IN ('cancelled','repaid') LIMIT 1", [record.id, removed.supplier_id], db)).length, 409, 'A supplier with active invoices cannot be removed from this programme');
        await rows('DELETE FROM portal_programme_suppliers WHERE programme_id=$1', [record.id], db);
        for (const supplier of ids) {
            await rows('INSERT INTO portal_programme_suppliers VALUES($1,$2)', [record.id, supplier], db);
            await rows('INSERT INTO portal_supplier_relationships(buyer_id,supplier_id,created_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [record.buyer_id, supplier, actor.id], db);
        }
    }
    if (data.financier_ids !== undefined) {
        const ids = z.array(id).max(250).parse(data.financier_ids);
        for (const financer of ids)
            requireCondition((await rows('SELECT u.id FROM users u JOIN financier_profiles f ON f.user_id=u.id WHERE u.id=$1 AND u.role=3 AND u.disabled_at IS NULL AND f.archived_at IS NULL', [financer], db)).length, 422, 'Financier is missing or archived');
        const old = await rows('SELECT financer_id FROM portal_programme_financiers WHERE programme_id=$1', [record.id], db);
        for (const removed of old.filter(r => !ids.includes(String(r.financer_id))))
            requireCondition(!(await rows('SELECT b.id FROM bids b JOIN invoices i ON i.id=b.invoice_id WHERE i.programme_id=$1 AND b.financer_id=$2 AND b.status IN (0,1) LIMIT 1', [record.id, removed.financer_id], db)).length, 409, 'A financier with pending or accepted offers cannot be removed');
        await rows('DELETE FROM portal_programme_financiers WHERE programme_id=$1', [record.id], db);
        for (const financer of ids)
            await rows('INSERT INTO portal_programme_financiers VALUES($1,$2)', [record.id, financer], db);
    }
}
async function options(entity: string, target: string, actor: Actor, db: DB) {
    const allowed = ['buyers', 'suppliers', 'financers', 'users', 'programmes', 'invoices', 'documents', 'fundings', 'payment_transactions'];
    requireCondition(allowed.includes(target), 404, 'Unsupported relationship lookup');
    if (target === 'buyers')
        return actor.role === 'platform_ops' ? await rows('SELECT id,name FROM buyers WHERE archived_at IS NULL', [], db) : await rows('SELECT id,name FROM buyers WHERE id=$1', [actor.buyer_id], db);
    if (target === 'programmes')
        return await rows(`SELECT p.id,p.name,p.status FROM programmes p WHERE p.archived_at IS NULL AND ($1 OR p.buyer_id=$2 OR EXISTS(SELECT 1 FROM portal_programme_suppliers ps JOIN suppliers s ON s.id=ps.supplier_id WHERE ps.programme_id=p.id AND s.user_id=$3) OR EXISTS(SELECT 1 FROM portal_programme_financiers pf WHERE pf.programme_id=p.id AND pf.financer_id=$3))`, [actor.role === 'platform_ops', actor.role === 'buyer_admin' ? actor.buyer_id : null, actor.id], db);
    if (target === 'suppliers')
        return actor.role === 'platform_ops' ? await rows('SELECT id,name FROM suppliers WHERE archived_at IS NULL', [], db) : actor.role === 'supplier_user' ? await rows('SELECT id,name FROM suppliers WHERE user_id=$1', [actor.id], db) : await rows("SELECT s.id,s.name FROM suppliers s JOIN portal_supplier_relationships r ON r.supplier_id=s.id WHERE r.buyer_id=$1 AND r.status='active' AND s.archived_at IS NULL", [actor.buyer_id], db);
    if (target === 'financers')
        return await rows('SELECT u.id,f.name FROM users u JOIN financier_profiles f ON f.user_id=u.id WHERE u.role=3 AND u.disabled_at IS NULL AND f.archived_at IS NULL AND ($1 OR u.id=$2 OR $3)', [actor.role === 'platform_ops', actor.id, actor.role === 'buyer_admin' && !!actor.buyer_id], db);
    if (target === 'users')
        return await rows('SELECT id,coalesce(name,email) AS name FROM users WHERE disabled_at IS NULL AND ($1 OR buyer_id=$2 OR id=$3)', [actor.role === 'platform_ops', actor.buyer_id, actor.id], db);
    if (target === 'invoices') {
        let list = (await resourceRequest(actor, 'GET', ['invoices'])).data as Row[];
        if (entity === 'financing_requests')
            list = list.filter(r => r.status === 'approved' && r.financing_eligible && !r.financial_review_required);
        return list.filter(r => !r.deleted_at).map(r => ({ id: r.id, name: `${r.invoice_number ?? '#' + r.id} · ${r.currency ?? 'currency missing'} ${r.amount ?? 'amount missing'}` }));
    }
    if (target === 'documents')
        return (await listRecords('documents', actor, db)).map(r => ({ id: r.id, name: r.file_name }));
    requireRole(actor, 'platform_ops');
    return await rows(`SELECT id,id::text AS name FROM "${target}" ORDER BY id DESC LIMIT 250`, [], db);
}
export async function managementRequest(actor: Actor, method: string, path: string[], body: Row): Promise<{
    data?: unknown;
    status?: number;
}> {
    if (path[1] === 'modules') {
        requireCondition(method === 'GET', 405, 'Method not allowed');
        return { data: workflowModules.filter(m => m.roles.includes(actor.role)) };
    }
    const entity = path[2];
    const definition = moduleDefinition(actor, entity);
    const recordId = path[3] && path[3] !== 'options' ? id.parse(path[3]) : undefined;
    const action = path[4];
    requireCondition(path.length <= 5, 404, 'Unknown management route');
    return transaction(async (db) => {
        if (path[3] === 'options') {
            requireCondition(method === 'GET' && action, 405, 'Method not allowed');
            return { data: await options(entity, action, actor, db) };
        }
        if (method === 'GET') {
            const records = await listRecords(entity, actor, db, recordId, true);
            if (recordId)
                requireCondition(records.length, 404, 'Record not found');
            const output = [];
            for (const r of records)
                output.push({ ...r, _actions: await actionsFor(entity, r, actor, db) });
            return { data: recordId ? output[0] : output };
        }
        requireCondition(!definition.readOnly, 409, definition.description);
        const input = rawInput(body);
        let previous = recordId ? (await listRecords(entity, actor, db, recordId, true))[0] : undefined;
        if (recordId)
            requireCondition(previous, 404, 'Record not found');
        if (recordId && entity === 'tenders')
            await invoice(actor, String(previous!.invoice_id), db, true);
        if (recordId && !['buyers', 'suppliers', 'financers', 'users'].includes(entity))
            await rows(`SELECT id FROM "${entity === 'exceptions' ? 'portal_exceptions' : tableFor(entity)}" WHERE id=$1 FOR UPDATE`, [recordId], db);
        if (recordId) {
            previous = (await listRecords(entity, actor, db, recordId, true))[0];
            requireCondition(previous, 404, 'Record not found');
            if (method === 'PATCH') assertFresh(previous);
        }
        const permissions: Row = previous ? await actionsFor(entity, previous, actor, db) : {};
        if (recordId && action) {
            requireCondition(method === 'POST', 405, 'Lifecycle actions require POST');
            return { data: await transition(entity, recordId, action, input, previous!, actor, db) };
        }
        if (method === 'DELETE') {
            requireCondition(recordId && permissions.delete, 409, permissions.reason ?? 'This record cannot be deleted; archive it to retain its history');
            if (entity === 'bids') {
                requireRole(actor, 'financer');
                await rows('DELETE FROM bids WHERE id=$1 AND financer_id=$2 AND portal_state=$3 AND status=0', [recordId, actor.id, 'DRAFT'], db);
            }
            else if (entity === 'invoices') {
                await rows('UPDATE invoices SET deleted_at=now(),updated_at=now() WHERE id=$1', [recordId], db);
            }
            else if (entity === 'users') {
                await disableUser(actor, previous!, db);
            }
            else if (entity === 'documents') {
                await rows('UPDATE documents SET archived_at=now(),updated_at=now() WHERE id=$1', [recordId], db);
            }
            else if (entity === 'programmes') {
                await rows('DELETE FROM portal_programme_suppliers WHERE programme_id=$1', [recordId], db);
                await rows('DELETE FROM portal_programme_financiers WHERE programme_id=$1', [recordId], db);
                await rows('DELETE FROM programmes WHERE id=$1', [recordId], db);
            }
            else
                await rows(`DELETE FROM "${entity === 'exceptions' ? 'portal_exceptions' : entity}" WHERE id=$1`, [recordId], db);
            await portalEvent(actor, `${entity}.deleted`, typeof input.reason === 'string' ? input.reason : null, null, { record_id: recordId, before: previous }, db);
            return { status: 204 };
        }
        requireCondition(method === 'POST' && !recordId || method === 'PATCH' && recordId, 405, 'Unsupported management method');
        if (previous)
            requireCondition(permissions.edit, 409, permissions.reason ?? 'Record is locked');
        let result: Row;
        if (['buyers', 'suppliers', 'financers'].includes(entity)) {
            requireRole(actor, 'platform_ops');
            return await resourceRequest(actor, method, recordId ? [entity, recordId] : [entity], input);
        }
        if (entity === 'users') {
            if (actor.role === 'platform_ops')
                return await resourceRequest(actor, method, recordId ? ['users', recordId] : ['users'], input);
            requireRole(actor, 'buyer_admin');
            requireCondition(!input.role || input.role === 'buyer_admin', 403, 'Only buyer administrator accounts can be assigned here');
            requireCondition(previous?.role !== 'platform_ops' && previous?.role !== 'financer', 403, 'Cannot manage a privileged account');
            await resourceRequest(actor, 'PATCH', ['buyers', String(actor.buyer_id)], { buyer: { users_attributes: [{ ...input, ...(recordId ? { id: recordId } : {}), role: 'buyer_admin' }] } });
            result = (await rows('SELECT id,email,name,role,buyer_id,created_at,updated_at FROM users WHERE buyer_id=$1 AND email=$2', [actor.buyer_id, input.email ?? previous?.email], db))[0];
        }
        else if (entity === 'programmes') {
            requireCondition(ownerRole(actor), 403, 'Forbidden');
            const target = actor.role === 'platform_ops' ? id.parse(input.buyer_id ?? previous?.buyer_id) : String(actor.buyer_id);
            requireCondition(target && target !== 'null', 422, 'Choose the buyer organisation');
            if (previous)
                requireCondition(same(previous.buyer_id, target), 422, 'Programme ownership cannot be transferred');
            const [buyer] = await rows('SELECT id FROM buyers WHERE id=$1 AND archived_at IS NULL', [target], db);
            requireCondition(buyer, 422, 'Buyer is missing or archived');
            rejectManagedFields('programmes', input);
            const data = draftSchema('programmes', !!recordId).extend({ name: z.string().trim().min(2), currency: currencies }).parse({ ...previous, ...withoutBlankRequired('programmes', input) });
            await validateFieldReferences('programmes', data, actor, db);
            result = await save('programmes', { ...databaseValues('programmes', data), buyer_id: target, configured_by: actor.id, ...(!recordId ? { created_by: actor.id, status: 'draft' } : {}) }, db, recordId);
            await partners(result, input, actor, db);
        }
        else if (entity === 'invoices') {
            requireCondition(ownerRole(actor), 403, 'Only the buyer or operations can edit invoice terms');
            rejectManagedFields('invoices', input);
            requireCondition(input.status === undefined || input.status === 'draft', 403, 'Use the lifecycle actions to submit or cancel invoices');
            const parsed = draftSchema('invoices', !!recordId).extend({ programme_id: id, supplier_id: id, invoice_number: z.string().trim().min(1).max(100) }).parse({ ...previous, ...withoutBlankRequired('invoices', input) });
            const p = await programme(actor, String(parsed.programme_id), db, true);
            requireCondition(!p.archived_at, 409, 'Programme is archived');
            requireCondition((await rows('SELECT id FROM buyers WHERE id=$1 AND archived_at IS NULL', [p.buyer_id], db)).length, 409, 'Buyer organisation is archived');
            const [relation] = await rows("SELECT s.id FROM suppliers s JOIN portal_programme_suppliers ps ON ps.supplier_id=s.id JOIN programmes p ON p.id=ps.programme_id JOIN portal_supplier_relationships r ON r.buyer_id=p.buyer_id AND r.supplier_id=s.id AND r.status='active' WHERE ps.programme_id=$1 AND s.id=$2 AND s.archived_at IS NULL", [p.id, parsed.supplier_id], db);
            requireCondition(relation, 422, 'Add this supplier to the programme before creating an invoice');
            const values: Row = { ...parsed, currency: input.currency ?? previous?.currency ?? p.currency ?? null, amount: parsed.amount ?? null, status: 'draft' };
            requireCondition(!values.issue_date || !values.due_date || values.due_date >= values.issue_date, 422, 'Due date must not precede issue date');
            requireCondition(!values.financing_amount_requested || values.amount && cents(values.financing_amount_requested) <= cents(values.amount), 422, 'Requested financing exceeds invoice amount');
            await validateFieldReferences('invoices', values, actor, db);
            result = await save('invoices', databaseValues('invoices', values), db, recordId);
        }
        else if (entity === 'bids') {
            throw new ApiError(422, 'Create and edit financing offers from the invited opportunity');
        }
        else if (entity === 'tenders') {
            requireCondition(recordId, 422, 'Create tenders from an approved invoice');
            result = await editTender(actor, previous!, input, db);
        }
        else if (entity === 'supplier_relationships') {
            requireCondition(recordId, 422, 'Use Add supplier to invite or connect a supplier');
            result = await editRelationship(actor, previous!, input, db);
        }
        else if (entity === 'documents') {
            requireCondition(recordId, 422, 'Upload the actual file before editing document metadata');
            const data = z.object({ file_name: z.string().trim().min(1).max(200).optional(), category: z.string().trim().min(1).max(100).optional() }).strict().parse(input);
            result = await save('documents', data, db, recordId);
        }
        else if (entity === 'exceptions') {
            requireRole(actor, 'platform_ops');
            const data = z.object({ invoice_id: id.nullable().optional(), org_ref: z.string().max(100).nullable().optional(), kind: z.enum(['FAILED_DISBURSEMENT', 'UNMATCHED_REPAYMENT', 'DISPUTE', 'COMPLIANCE_REVIEW']), summary: z.string().trim().min(10).max(4000) }).parse({ ...previous, ...input });
            if (data.invoice_id)
                await invoice(actor, data.invoice_id, db);
            result = await save('portal_exceptions', { ...data, ...(!recordId ? { status: 'OPEN' } : {}) }, db, recordId);
        }
        else {
            rejectManagedFields(entity, input);
            const data = fieldSchema(entity, !!recordId, { exclude: entity === 'financing_requests' ? ['supplier_id', 'currency', 'idempotency_key'] : entity === 'mandate_versions' && actor.role === 'financer' ? ['financier_id'] : [] }).parse(input);
            const values = { ...data };
            if (entity === 'financing_requests') {
                requireRole(actor, 'supplier_user', 'platform_ops');
                const target = await invoice(actor, id.parse(data.invoice_id ?? previous?.invoice_id), db, true);
                requireCondition(target.status === 'approved' && target.invoice_approval_status === 'approved' && target.financing_eligible && !target.financial_review_required && !target.deleted_at, 409, 'Select an approved eligible invoice');
                requireCondition(cents(String(data.requested_amount ?? previous?.requested_amount)) <= cents(target.amount), 422, 'Requested financing exceeds invoice value');
                values.supplier_id = target.supplier_id;
                values.currency = target.currency;
                if (!recordId)
                    values.idempotency_key = randomUUID();
            }
            if (entity === 'mandate_versions') {
                if (actor.role === 'financer')
                    values.financier_id = actor.id;
                const combined = { ...previous, ...values };
                requireCondition(!combined.minimum_tenor_days || combined.minimum_tenor_days <= combined.maximum_tenor_days, 422, 'Minimum tenor exceeds maximum tenor');
                for (const code of combined.permitted_countries ?? [])
                    requireCondition(/^[A-Z]{2}$/.test(code), 422, 'Use two-letter country codes');
                for (const code of combined.permitted_currencies ?? [])
                    currencies.parse(code);
            }
            if (entity === 'conditions_precedent') {
                await programme(actor, id.parse(values.programme_id ?? previous?.programme_id), db);
                if (actor.role !== 'platform_ops')
                    requireCondition((await rows('SELECT id FROM users WHERE id=$1 AND (buyer_id=$2 OR role=2)', [values.owner_id ?? previous?.owner_id, actor.buyer_id], db)).length, 403, 'Condition owner must belong to this buyer or operations');
            }
            await validateFieldReferences(entity, { ...previous, ...values }, actor, db);
            result = await save(entity, { ...databaseValues(entity, values), last_modified_by: actor.id, ...(!recordId ? { created_by: actor.id } : {}) }, db, recordId);
        }
        await entityAudit(db, actor, definition.entity ?? entity, String(result.id), recordId ? 'updated' : 'created', previous ?? null, result);
        await portalEvent(actor, `${entity}.${recordId ? 'updated' : 'created'}`, null, entity === 'invoices' ? String(result.id) : null, { record_id: result.id }, db);
        return { data: { ...result, _actions: await actionsFor(entity, result, actor, db) }, status: recordId ? 200 : 201 };
    });
}
async function disableUser(actor: Actor, record: Row, db: DB) {
    requireCondition(!same(record.id, actor.id), 409, 'You cannot disable your own account');
    // Serialise role-count checks with the same lock used by role changes, so concurrent removals cannot remove the last administrator.
    await lockOperatorSet(db);
    const [user] = await rows('SELECT * FROM users WHERE id=$1 FOR UPDATE', [record.id], db);
    requireCondition(user, 404, 'User not found');
    requireCondition(actor.role === 'platform_ops' || actor.role === 'buyer_admin' && same(user.buyer_id, actor.buyer_id) && user.role === 0, 403, 'Account is outside your management scope');
    if (user.role === 2)
        requireCondition((await rows('SELECT id FROM users WHERE role=2 AND disabled_at IS NULL AND id<>$1', [user.id], db)).length, 409, 'Keep at least one operations administrator');
    if (user.role === 0)
        requireCondition((await rows('SELECT id FROM users WHERE role=0 AND buyer_id=$1 AND disabled_at IS NULL AND id<>$2', [user.buyer_id, user.id], db)).length, 409, 'Keep at least one buyer administrator');
    await rows('UPDATE users SET disabled_at=now(),updated_at=now() WHERE id=$1', [user.id], db);
    await revokeSessions(String(user.id), db);
}
async function editRelationship(actor: Actor, previous: Row, input: Row, db: DB) {
    const data = z.object({ contact_name: z.string().max(200).nullable().optional(), contact_email: email.nullable().optional(), contact_phone: z.string().max(100).nullable().optional(), payment_terms: z.string().max(4000).nullable().optional(), notes: z.string().max(4000).nullable().optional(), programme_ids: z.array(id).max(250).optional() }).strict().parse(input);
    if (data.programme_ids) {
        const programmes = await rows('SELECT id FROM programmes WHERE buyer_id=$1', [previous.buyer_id], db);
        for (const p of data.programme_ids)
            requireCondition(programmes.some(r => same(r.id, p)), 403, 'Programme is outside this relationship');
        for (const p of programmes) {
            const linked = (await rows('SELECT 1 FROM portal_programme_suppliers WHERE programme_id=$1 AND supplier_id=$2', [p.id, previous.supplier_id], db)).length;
            const selected = data.programme_ids.some(key => same(p.id, key));
            if (linked && !selected) {
                requireCondition(!(await rows("SELECT id FROM invoices WHERE programme_id=$1 AND supplier_id=$2 AND deleted_at IS NULL AND status NOT IN ('cancelled','repaid') LIMIT 1", [p.id, previous.supplier_id], db)).length, 409, 'A programme with active invoices cannot be removed');
                await rows('DELETE FROM portal_programme_suppliers WHERE programme_id=$1 AND supplier_id=$2', [p.id, previous.supplier_id], db);
            }
            if (selected)
                await rows('INSERT INTO portal_programme_suppliers VALUES($1,$2) ON CONFLICT DO NOTHING', [p.id, previous.supplier_id], db);
        }
    }
    const { programme_ids: ignored, ...values } = data;
    void ignored;
    if (Object.keys(values).length) {
        const keys = Object.keys(values);
        await rows(`UPDATE portal_supplier_relationships SET ${keys.map((k, i) => '"' + k + '"=$' + (i + 3)).join(',')},updated_at=now() WHERE buyer_id=$1 AND supplier_id=$2`, [previous.buyer_id, previous.supplier_id, ...Object.values(values)], db);
    }
    return (await listRecords('supplier_relationships', actor, db, String(previous.id), true))[0];
}
async function editTender(actor: Actor, previous: Row, input: Row, db: DB) {
    const target = await invoice(actor, String(previous.invoice_id), db, true);
    requireCondition(!(await rows("SELECT id FROM bids WHERE invoice_id=$1 AND status IN (0,1) AND portal_state IS DISTINCT FROM 'WITHDRAWN' LIMIT 1", [target.id], db)).length, 409, 'Withdraw offers or cancel the tender before changing its terms');
    const data = z.object({ closes_at: z.string().datetime().optional(), eligible_conditions: z.string().max(4000).optional(), risk_disclosures: z.string().max(4000).optional() }).strict().parse(input);
    if (data.closes_at)
        requireCondition(Date.parse(data.closes_at) > Date.now() && data.closes_at.slice(0, 10) <= target.due_date, 422, 'Tender close must be in the future and no later than maturity');
    return await save('financing_tenders', data, db, String(previous.id));
}
async function transition(entity: string, recordId: string, action: string, input: Row, previous: Row, actor: Actor, db: DB) {
    const allowed = await actionsFor(entity, previous, actor, db);
    requireCondition((allowed as Row)[action] === true, 409, (allowed as Row).reason ?? 'This action is unavailable in the current state');
    const reason = reasonSchema.parse(input.reason);
    let result: Row;
    if (entity === 'programmes') {
        await programme(actor, recordId, db, true);
        if (['submit', 'activate'].includes(action)) {
            coreSchema('programmes').parse(previous);
            requireCondition(previous.buyer_acceptance_authority !== 'unconfigured' && previous.allocation_policy !== 'unconfigured', 422, 'Configure acceptance authority and allocation policy before release');
            requireCondition((await rows('SELECT 1 FROM portal_programme_suppliers WHERE programme_id=$1', [recordId], db)).length && (await rows('SELECT 1 FROM portal_programme_financiers WHERE programme_id=$1', [recordId], db)).length, 422, 'Add at least one supplier and financier');
            requireCondition(!(await rows("SELECT id FROM conditions_precedent WHERE programme_id=$1 AND mandatory AND status<>'satisfied' LIMIT 1", [recordId], db)).length, 409, 'Satisfy mandatory conditions precedent before release');
        }
        result = await save('programmes', action === 'activate' ? { status: 'active', activated_at: new Date(), released_by: actor.id } : action === 'submit' ? { status: 'pending_review', created_by: actor.id } : action === 'pause' ? { status: 'paused', paused_at: new Date() } : action === 'archive' ? { archived_at: new Date(), archived_by: actor.id, archive_reason: reason } : { archived_at: null, status: 'draft' }, db, recordId);
    }
    else if (entity === 'invoices') {
        const current = await invoice(actor, recordId, db, true);
        requireCondition(!await invoiceLocked(current, db), 409, 'Financial history locks this invoice');
        if (action === 'submit') {
            await validateInvoiceSubmission(actor, current, db);
            result = await save('invoices', { invoice_approval_status: 'pending', submitted_for_approval_at: new Date(), rejection_reason: null, clarification_request: null }, db, recordId);
            await notify(current.supplier_user_id, 'Invoice awaiting approval', `Invoice ${current.invoice_number} needs your review.`, recordId, actor, db);
        }
        else if (action === 'withdraw') {
            requireCondition(!(await rows("SELECT id FROM financing_tenders WHERE invoice_id=$1 AND status='open'", [recordId], db)).length, 409, 'Cancel the open tender first');
            result = await save('invoices', { status: 'draft', invoice_approval_status: 'not_requested', submitted_for_approval_at: null, supplier_approved_at: null, supplier_approved_by: null }, db, recordId);
        }
        else if (action === 'cancel') {
            await rows("UPDATE financing_tenders SET status='cancelled',cancelled_at=now(),cancelled_by=$2,cancellation_reason=$3,updated_at=now() WHERE invoice_id=$1 AND status='open'", [recordId, actor.id, reason], db);
            result = await save('invoices', { status: 'cancelled', cancelled_at: new Date(), cancelled_by: actor.id, cancellation_reason: reason }, db, recordId);
        }
        else
            result = await save('invoices', { deleted_at: null }, db, recordId);
    }
    else if (entity === 'bids') {
        result = await save('bids', { status: 2, portal_state: 'WITHDRAWN' }, db, recordId);
    }
    else if (entity === 'tenders') {
        const current = await invoice(actor, String(previous.invoice_id), db, true);
        requireCondition(!(await rows('SELECT id FROM bids WHERE invoice_id=$1 AND status=1', [current.id], db)).length, 409, 'An accepted offer prevents tender cancellation');
        result = await save('financing_tenders', { status: 'cancelled', cancelled_at: new Date(), cancelled_by: actor.id, cancellation_reason: reason }, db, recordId);
        await rows("UPDATE bids SET status=2,portal_state='WITHDRAWN',updated_at=now() WHERE invoice_id=$1 AND status=0", [current.id], db);
        await save('invoices', { status: 'approved' }, db, String(current.id));
    }
    else if (['buyers', 'suppliers', 'financers'].includes(entity)) {
        requireRole(actor, 'platform_ops');
        const table = tableFor(entity);
        const key = entity === 'financers' ? 'user_id' : 'id';
        if (action === 'archive') {
            const users = await rows(entity === 'buyers' ? 'SELECT id FROM users WHERE buyer_id=$1' : entity === 'suppliers' ? 'SELECT user_id AS id FROM suppliers WHERE id=$1' : 'SELECT user_id AS id FROM financier_profiles WHERE user_id=$1', [recordId], db);
            for (const user of users) {
                requireCondition(!same(user.id, actor.id), 409, 'You cannot archive your own organisation');
                await rows('UPDATE users SET disabled_at=now() WHERE id=$1', [user.id], db);
                await revokeSessions(String(user.id), db);
            }
        }
        result = (await rows(`UPDATE ${table} SET archived_at=${action === 'archive' ? 'now()' : 'NULL'},updated_at=now() WHERE ${key}=$1 RETURNING *`, [recordId], db))[0];
    }
    else if (entity === 'users') {
        const archived = await rows('SELECT 1 FROM users u LEFT JOIN buyers b ON b.id=u.buyer_id LEFT JOIN suppliers s ON s.user_id=u.id LEFT JOIN financier_profiles f ON f.user_id=u.id WHERE u.id=$1 AND (b.archived_at IS NOT NULL OR s.archived_at IS NOT NULL OR f.archived_at IS NOT NULL)', [recordId], db);
        requireCondition(!archived.length, 409, 'Restore the organisation before restoring access');
        requireCondition(action === 'restore', 409, 'Unsupported user action');
        requireCondition(actor.role === 'platform_ops' || previous.role === 'buyer_admin' && same(previous.buyer_id, actor.buyer_id), 403, 'Forbidden');
        result = await save('users', { disabled_at: null }, db, recordId);
        result = { id: result.id, email: result.email, disabled_at: result.disabled_at };
    }
    else if (entity === 'supplier_relationships') {
        requireCondition(actor.role === 'platform_ops' || same(previous.buyer_id, tenantBuyer(actor)), 403, 'Relationship is outside your organisation');
        result = (await rows('UPDATE portal_supplier_relationships SET status=$3,updated_at=now() WHERE buyer_id=$1 AND supplier_id=$2 RETURNING *', [previous.buyer_id, previous.supplier_id, action === 'archive' ? 'archived' : 'active'], db))[0];
    }
    else if (entity === 'financing_requests') {
        if (action === 'submit') {
            const current = await invoice(actor, String(previous.invoice_id), db, true);
            requireCondition(current.status === 'approved' && current.financing_eligible && !await invoiceLocked(current, db), 409, 'Invoice is no longer available for early payment');
        }
        result = await save(entity, action === 'submit' ? { status: 'submitted', submitted_by: actor.id, requested_at: new Date() } : ['review', 'decline'].includes(action) ? { status: action === 'review' ? 'reviewed' : 'declined', reviewed_by: actor.id, reviewed_at: new Date(), review_note: reason } : { status: 'withdrawn' }, db, recordId);
    }
    else if (entity === 'mandate_versions') {
        if (action === 'accept') {
            requireCondition(input.acknowledged === true, 422, 'Explicitly acknowledge the mandate terms');
            const hash = createHash('sha256').update(JSON.stringify(previous)).digest('hex');
            await save('mandate_acceptances', { created_by: actor.id, mandate_id: recordId, accepted_by: actor.id, accepted_at: new Date(), evidence_hash: hash }, db);
        }
        result = await save(entity, action === 'submit' ? { status: 'pending_review' } : action === 'approve' ? { status: 'pending_acceptance', approved_by: actor.id, approved_at: new Date() } : { status: 'active' }, db, recordId);
    }
    else if (entity === 'limits') {
        requireCondition(!previous.effective_to || previous.effective_to >= previous.effective_from, 422, 'Effective end precedes start');
        result = await save(entity, action === 'submit' ? { status: 'pending_review' } : { status: 'active', approved_by: actor.id, approved_at: new Date() }, db, recordId);
    }
    else if (entity === 'conditions_precedent') {
        requireCondition(previous.evidence_id, 422, 'Attach evidence before recording satisfaction');
        const [evidence] = await rows('SELECT review_status,archived_at,upload_status FROM documents WHERE id=$1', [previous.evidence_id], db);
        requireCondition(evidence && !evidence.archived_at && evidence.upload_status === 'stored' && evidence.review_status === 'verified', 409, 'The evidence must be verified by operations before the condition can be satisfied');
        await validateFieldReferences(entity, previous, actor, db);
        result = await save(entity, { status: 'satisfied', satisfied_at: new Date() }, db, recordId);
    }
    else if (entity === 'reconciliation_cases') {
        result = await save(entity, { status: 'resolved', resolution: reason, cleared_by: actor.id, cleared_at: new Date() }, db, recordId);
    }
    else if (entity === 'exceptions')
        result = await save('portal_exceptions', { status: 'RESOLVED', resolution_note: reason, updated_by: actor.id }, db, recordId);
    else
        throw new ApiError(409, 'No lifecycle transition exists for this module');
    await portalEvent(actor, `${entity}.${action}`, reason, entity === 'invoices' ? recordId : null, { record_id: recordId, before: previous, after: entity === 'users' ? { id: recordId } : result }, db);
    return { ...result, _actions: await actionsFor(entity, result, actor, db) };
}
