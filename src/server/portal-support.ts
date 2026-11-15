import { type Actor, privilegedMfaRequired } from './auth';
import { rows, type DB, type Row } from './db';
import { currentRequest } from './context';

/** The caller's network address for the audit trail (NFR-AUD-001), when the deployment identifies it. */
export function requestIp(): string | null { const ip = currentRequest()?.clientIp; return ip && !['unconfigured', 'unknown'].includes(ip) ? ip : null; }
export async function orgRef(actor: Actor, db?: DB): Promise<string | null> {
    if (actor.role === 'platform_ops')
        return 'platform';
    if (actor.role === 'buyer_admin')
        return actor.buyer_id ? `buyer-${actor.buyer_id}` : null;
    if (actor.role === 'financer') {
        const [p] = await rows('SELECT user_id FROM financier_profiles WHERE user_id=$1', [actor.id], db);
        return p ? `financier-${actor.id}` : null;
    }
    const [supplier] = await rows('SELECT id FROM suppliers WHERE user_id=$1', [actor.id], db);
    return supplier ? `supplier-${supplier.id}` : null;
}
export async function portalEvent(actor: Actor, event: string, reason: string | null = null, invoiceId: string | null = null, details: Row = {}, db?: DB) {
    // When an administrator acts for an organisation, the event names the organisation account and the administrator.
    await rows('INSERT INTO portal_events(actor_id,org_ref,invoice_id,event,reason,details,acting_admin_id,ip) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [actor.id, actor.delegation?.target ?? await orgRef(actor, db), invoiceId, event, reason ?? (actor.delegation ? `On behalf of the organisation: ${actor.delegation.reason}` : null), JSON.stringify(details), actor.delegation?.admin_id ?? null, requestIp()], db);
}
/**
 * Every notification is recorded in-app and queued for email (SRS §13.4: in-app and email as a minimum, retried on
 * failure, logged against the recipient). A person who has switched email off in their preferences gets in-app only;
 * notices the SRS marks as never suppressible (bank-detail changes) pass `force: true`.
 */
export async function notify(userId: string, subject: string, body: string, invoiceId: string | null, actor: Actor | null, db: DB, options: { orgRef?: string | null; force?: boolean; eventType?: string } = {}) {
    await rows("INSERT INTO notifications(user_id,event_type,channel,subject,body,related_resource,related_id,status,created_by,org_ref,delivered_at) VALUES($1,$2,'in_app',$3,$4,'invoices',$5,'delivered',$6,$7,now())", [userId, options.eventType ?? 'portal', subject, body, invoiceId, actor?.id ?? null, options.orgRef ?? null], db);
    const [user] = await rows('SELECT notification_preferences FROM users WHERE id=$1', [userId], db);
    if (options.force || user?.notification_preferences?.email !== false)
        await rows("INSERT INTO notifications(user_id,event_type,channel,subject,body,related_resource,related_id,status,created_by,org_ref,delivery_attempts,next_attempt_at) VALUES($1,$2,'email',$3,$4,'invoices',$5,'queued',$6,$7,0,now())", [userId, options.eventType ?? 'portal', subject, body, invoiceId, actor?.id ?? null, options.orgRef ?? null], db);
}
/** An email to a contact who is not a platform user (e.g. an organisation's finance contact), queued and logged the same way. */
export async function notifyContact(address: string, subject: string, body: string, actor: Actor | null, db: DB, orgRef: string | null = null, eventType = 'portal') {
    await rows("INSERT INTO notifications(recipient,event_type,channel,subject,body,status,created_by,org_ref,delivery_attempts,next_attempt_at) VALUES($1,$6,'email',$2,$3,'queued',$4,$5,0,now())", [address, subject, body, actor?.id ?? null, orgRef, eventType], db);
}
export async function sessionData(actor: Actor) {
    const [user] = await rows('SELECT id,name,email,job_title,contact_phone,notification_preferences,email_verified_at,mfa_enrolled_at,portal_registration,super_admin FROM users WHERE id=$1', [actor.id]);
    const ref = await orgRef(actor);
    const [review] = ref ? await rows('SELECT status FROM portal_org_reviews WHERE org_ref=$1', [ref]) : [];
    const [state] = ref && ref !== 'platform' ? await rows('SELECT status,tier,legacy FROM organisation_lifecycle WHERE org_ref=$1', [ref]) : [];
    const { mfa_verified: _verified, delegation, ...publicActor } = actor;
    const { super_admin: superAdmin, ...profile } = user;
    return { actor: publicActor, user: profile, org_ref: ref, super_admin: !delegation && actor.role === 'platform_ops' && !!superAdmin,
        // Shown as a persistent banner while an administrator works on behalf of the organisation.
        acting: delegation ? { target: delegation.target, name: delegation.target_name, reason: delegation.reason, admin_name: delegation.admin_name ?? delegation.admin_email } : null, needs_onboarding: user.portal_registration && (!ref || review?.status !== 'APPROVED'),
        // Operations sessions stay restricted to authenticator enrolment until a code has been verified.
        mfa_enrolment_required: privilegedMfaRequired(actor), active_membership: actor.role !== 'buyer_admin' || !!actor.buyer_id,
        // SRS status of the organisation (null for organisations live before the onboarding checklist).
        lifecycle: state && !state.legacy ? { status: state.status, tier: state.tier } : null };
}
