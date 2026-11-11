import { type Actor } from './auth';
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
    await rows('INSERT INTO portal_events(actor_id,org_ref,invoice_id,event,reason,details) VALUES($1,$2,$3,$4,$5,$6)', [actor.id, await orgRef(actor, db), invoiceId, event, reason, JSON.stringify(details)], db);
}
export async function notify(userId: string, subject: string, body: string, invoiceId: string | null, actor: Actor, db: DB) {
    await rows("INSERT INTO notifications(user_id,event_type,channel,subject,body,related_resource,related_id,status,created_by) VALUES($1,'portal','in_app',$2,$3,'invoices',$4,'delivered',$5)", [userId, subject, body, invoiceId, actor.id], db);
}
export async function sessionData(actor: Actor) {
    const [user] = await rows('SELECT id,name,email,job_title,contact_phone,notification_preferences,email_verified_at,mfa_enrolled_at,portal_registration FROM users WHERE id=$1', [actor.id]);
    const ref = await orgRef(actor);
    const [review] = ref ? await rows('SELECT status FROM portal_org_reviews WHERE org_ref=$1', [ref]) : [];
    return { actor, user, org_ref: ref, needs_onboarding: user.portal_registration && (!ref || review?.status !== 'APPROVED') };
}
