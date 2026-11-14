import { type Actor } from '../auth';
import { rows, type DB } from '../db';
import { requireCondition } from '../errors';

/**
 * Organisation status models from SRS Appendix B (§13.5.11 anchor, §13.7.10 funder, §13.6 supplier). Statuses are
 * server-owned: they change only here, only along an allowed edge, and every change writes an append-only event
 * recording the actor, the previous and new value and the reason (§13.4).
 */
export type Counterparty = 'ANCHOR' | 'FUNDER' | 'SUPPLIER';
const EDGES: Record<Counterparty, Record<string, string[]>> = {
  ANCHOR: {
    SETUP_IN_PROGRESS: ['COMPLIANCE_REVIEW', 'SETUP_ABANDONED'],
    DOCUMENTATION_OUTSTANDING: ['COMPLIANCE_REVIEW', 'SETUP_ABANDONED'],
    COMPLIANCE_REVIEW: ['VERIFIED', 'DOCUMENTATION_OUTSTANDING', 'DECLINED'],
    VERIFIED: ['CONFIGURED', 'SUSPENDED', 'DECLINED'],
    CONFIGURED: ['PENDING_ACTIVATION', 'SUSPENDED'],
    PENDING_ACTIVATION: ['ACTIVE', 'SUSPENDED'],
    ACTIVE: ['SUSPENDED', 'CLOSED'],
    SUSPENDED: ['ACTIVE', 'CLOSED'],
    SETUP_ABANDONED: ['SETUP_IN_PROGRESS'],
    DECLINED: [], CLOSED: [],
  },
  FUNDER: {
    SETUP_IN_PROGRESS: ['COMPLIANCE_REVIEW', 'SETUP_ABANDONED'],
    COMPLIANCE_REVIEW: ['VERIFIED', 'INFO_OUTSTANDING', 'DECLINED'],
    INFO_OUTSTANDING: ['COMPLIANCE_REVIEW', 'DECLINED'],
    VERIFIED: ['ACTIVE', 'SUSPENDED', 'SETUP_ABANDONED'],
    ACTIVE: ['SUSPENDED', 'CLOSED'],
    SUSPENDED: ['ACTIVE', 'CLOSED'],
    SETUP_ABANDONED: ['SETUP_IN_PROGRESS'],
    DECLINED: [], CLOSED: [],
  },
  SUPPLIER: {
    INVITED: ['REGISTERED'],
    REGISTERED: ['KYC_IN_REVIEW'],
    KYC_IN_REVIEW: ['VERIFIED', 'INFO_REQUIRED', 'DECLINED'],
    INFO_REQUIRED: ['KYC_IN_REVIEW', 'DECLINED'],
    VERIFIED: ['ACTIVE', 'SUSPENDED'],
    ACTIVE: ['SUSPENDED', 'CLOSED'],
    SUSPENDED: ['ACTIVE', 'CLOSED'],
    DECLINED: [], CLOSED: [],
  },
};
/** Statuses in which the organisation's set-up record may still be edited by Syndicate. */
export const EDITABLE_SETUP = ['SETUP_IN_PROGRESS', 'DOCUMENTATION_OUTSTANDING', 'INFO_OUTSTANDING'];
/** Statuses from which an organisation's people may use the platform (legacy organisations are always active). */
export const LIVE = ['ACTIVE'];

export type Lifecycle = { org_ref: string; counterparty: Counterparty; status: string; legacy: boolean; risk_rating: string | null; re_verification_due: string | null };
export async function lifecycle(ref: string, db?: DB, lock = false): Promise<Lifecycle | null> {
  const [row] = await rows(`SELECT * FROM organisation_lifecycle WHERE org_ref=$1${lock ? ' FOR UPDATE' : ''}`, [ref], db);
  return (row as Lifecycle) ?? null;
}
export async function startLifecycle(ref: string, counterparty: Counterparty, status: string, actor: Actor | null, reason: string, db: DB) {
  await rows('INSERT INTO organisation_lifecycle(org_ref,counterparty,status) VALUES($1,$2,$3)', [ref, counterparty, status], db);
  await rows('INSERT INTO organisation_status_events(org_ref,previous_status,new_status,actor_id,reason) VALUES($1,NULL,$2,$3,$4)', [ref, status, actor?.id ?? null, reason], db);
}
/** Moves an organisation along an allowed edge of its status model and audits the change. */
export async function transition(ref: string, to: string, actor: Actor | null, reason: string, db: DB) {
  const current = await lifecycle(ref, db, true);
  requireCondition(current, 404, 'Organisation not found');
  if (current.status === to) return current;
  requireCondition(EDGES[current.counterparty][current.status]?.includes(to), 409, `The organisation cannot move from ${label(current.status)} to ${label(to)}`);
  await rows('UPDATE organisation_lifecycle SET status=$2,updated_at=now() WHERE org_ref=$1', [ref, to], db);
  await rows('INSERT INTO organisation_status_events(org_ref,previous_status,new_status,actor_id,reason) VALUES($1,$2,$3,$4,$5)', [ref, current.status, to, actor?.id ?? null, reason], db);
  return { ...current, status: to };
}
export async function history(ref: string, db?: DB) {
  return rows('SELECT e.previous_status,e.new_status,e.reason,e.created_at,u.name AS actor_name FROM organisation_status_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.org_ref=$1 ORDER BY e.id', [ref], db);
}
export const label = (status: string) => status.toLowerCase().replaceAll('_', ' ');
