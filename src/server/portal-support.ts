import { type Actor, privilegedMfaRequired } from './auth';
import { rows, type DB, type Row } from './db';
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
    await rows('INSERT INTO portal_events(actor_id,org_ref,invoice_id,event,reason,details,acting_admin_id) VALUES($1,$2,$3,$4,$5,$6,$7)', [actor.id, actor.delegation?.target ?? await orgRef(actor, db), invoiceId, event, reason ?? (actor.delegation ? `On behalf of the organisation: ${actor.delegation.reason}` : null), JSON.stringify(details), actor.delegation?.admin_id ?? null], db);
}
export async function notify(userId: string, subject: string, body: string, invoiceId: string | null, actor: Actor, db: DB) {
    await rows("INSERT INTO notifications(user_id,event_type,channel,subject,body,related_resource,related_id,status,created_by) VALUES($1,'portal','in_app',$2,$3,'invoices',$4,'delivered',$5)", [userId, subject, body, invoiceId, actor.id], db);
}
export async function sessionData(actor: Actor) {
    const [user] = await rows('SELECT id,name,email,job_title,contact_phone,notification_preferences,email_verified_at,mfa_enrolled_at,portal_registration,super_admin FROM users WHERE id=$1', [actor.id]);
    const ref = await orgRef(actor);
    const [review] = ref ? await rows('SELECT status FROM portal_org_reviews WHERE org_ref=$1', [ref]) : [];
    const { mfa_verified: _verified, delegation, ...publicActor } = actor;
    const { super_admin: superAdmin, ...profile } = user;
    return { actor: publicActor, user: profile, org_ref: ref, super_admin: !delegation && actor.role === 'platform_ops' && !!superAdmin,
        // Shown as a persistent banner while an administrator works on behalf of the organisation.
        acting: delegation ? { target: delegation.target, name: delegation.target_name, reason: delegation.reason, admin_name: delegation.admin_name ?? delegation.admin_email } : null, needs_onboarding: user.portal_registration && (!ref || review?.status !== 'APPROVED'),
        // Operations sessions stay restricted to authenticator enrolment until a code has been verified.
        mfa_enrolment_required: privilegedMfaRequired(actor), active_membership: actor.role !== 'buyer_admin' || !!actor.buyer_id };
}
