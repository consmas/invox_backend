import { z } from 'zod';
import { type Actor, digest, newToken, hashPassword, revokeSessions } from '../auth';
import { rows, transaction, type DB, type Row } from '../db';
import { requireCondition } from '../errors';
import { id, email } from '../validation';
import { sendLink, appUrl } from '../mail';
import { sendSms } from '../integrations';
import { portalEvent, notify } from '../portal-support';
import { lifecycle, startLifecycle, transition } from './lifecycle';

/**
 * SRS stage S1 (with the anchor's side at A6): the anchor invites a supplier onto one of its live programmes.
 * The invitation names the anchor, travels by email or — where the anchor holds only a mobile number — by SMS, and
 * carries one single-use, time-limited link. A supplier already on the platform is linked to the new programme and
 * never duplicated or re-verified; the anchor never learns which other programmes it belongs to.
 */
const same = (a: unknown, b: unknown) => String(a) === String(b);
const inviteInput = z.object({
  name: z.string().trim().min(2, 'Enter the supplier’s name').max(200),
  email: email.optional().or(z.literal('').transform(() => undefined)),
  phone: z.string().trim().max(30).optional().transform(value => value || undefined),
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).default('GH'),
  registration_number: z.string().trim().max(100).optional().transform(value => value || undefined),
  contact: z.string().trim().max(200).optional(),
  programme_id: id,
});
async function validityDays(db: DB) {
  const [row] = await rows("SELECT value FROM onboarding_settings WHERE key='invitation_validity_days'", [], db);
  return Number(row?.value?.SUPPLIER ?? 7);
}
type Delivery = { channel: 'email' | 'sms' | 'existing'; sent: boolean; preview_url?: string; warning?: string };
/** Sends the enrolment link on the channel the anchor's data allows; a failure is reported, never silent (§13.4). */
async function deliver(supplier: Row, anchorName: string, token: string): Promise<Delivery> {
  const link = `${appUrl()}/invite?token=${token}`;
  if (supplier.email) {
    try { return { channel: 'email', sent: true, ...await sendLink(supplier.email, `${anchorName} invites you to get paid early with INVOX`, link) }; }
    catch (error) { if (!supplier.contact_phone) return { channel: 'email', sent: false, warning: `The invitation email could not be sent (${(error as Error).message}).` }; }
  }
  try { await sendSms([supplier.contact_phone], `${anchorName} invites you to get paid early on its invoices with INVOX. Set up your account: ${link}`); return { channel: 'sms', sent: true }; }
  catch (error) {
    const preview = ['development', 'test'].includes(process.env.NODE_ENV ?? '') ? { preview_url: link } : {};
    return { channel: 'sms', sent: false, warning: `The invitation SMS could not be sent (${(error as Error).message}).`, ...preview };
  }
}
export async function inviteSupplier(actor: Actor, body: unknown) {
  const data = inviteInput.parse(body);
  requireCondition(data.email || data.phone, 422, 'Give the supplier’s email address or mobile number');
  const outcome = await transaction(async db => {
    const [programme] = await rows('SELECT p.*,b.name AS anchor_name FROM programmes p JOIN buyers b ON b.id=p.buyer_id WHERE p.id=$1', [data.programme_id], db);
    requireCondition(programme && (actor.role === 'platform_ops' || same(programme.buyer_id, actor.buyer_id)), 403, 'Programme is outside your organisation');
    requireCondition(!programme.archived_at, 409, 'Programme is archived');
    requireCondition(programme.status === 'active', 409, 'Suppliers can be invited once the programme has been released');
    // Never duplicate: the same email, or the same registration number in the same country, is the same supplier.
    const [existing] = await rows(`SELECT * FROM suppliers WHERE ($1::text IS NOT NULL AND lower(email)=$1) OR ($2::text IS NOT NULL AND upper(country)=$3 AND lower(trim(registration_number))=lower($2)) ORDER BY id LIMIT 1`, [data.email ?? null, data.registration_number ?? null, data.country], db);
    requireCondition(!existing?.archived_at, 409, 'This supplier cannot be invited at the moment. Contact INVOX operations.');
    let supplier = existing; let token: string | null = null;
    if (!supplier) {
      token = newToken();
      const days = await validityDays(db);
      [supplier] = await rows(`INSERT INTO suppliers(name,email,contact_phone,country,registration_number,invitation_token,invited_at,invitation_expires_at,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,now(),now()+make_interval(days => $7),now(),now()) RETURNING *`, [data.name, data.email ?? null, data.phone ?? null, data.country, data.registration_number ?? null, digest(token), days], db);
      await startLifecycle(`supplier-${supplier.id}`, 'SUPPLIER', 'INVITED', actor, `Invited by ${programme.anchor_name}`, db);
    }
    await rows('INSERT INTO portal_programme_suppliers VALUES($1,$2) ON CONFLICT DO NOTHING', [programme.id, supplier.id], db);
    await rows(`INSERT INTO portal_supplier_relationships(buyer_id,supplier_id,contact_name,contact_email,contact_phone,created_by) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(buyer_id,supplier_id) DO UPDATE SET contact_name=coalesce(EXCLUDED.contact_name,portal_supplier_relationships.contact_name),contact_email=coalesce(EXCLUDED.contact_email,portal_supplier_relationships.contact_email),contact_phone=coalesce(EXCLUDED.contact_phone,portal_supplier_relationships.contact_phone),updated_at=now()`,
      [programme.buyer_id, supplier.id, data.contact ?? null, data.email ?? null, data.phone ?? null, actor.id], db);
    await rows(`INSERT INTO programme_enrolments(programme_id,supplier_id,status,invited_by,channel) VALUES($1,$2,'PENDING_ENROLMENT',$3,$4) ON CONFLICT(programme_id,supplier_id) DO NOTHING`, [programme.id, supplier.id, actor.id, token ? null : 'existing'], db);
    await portalEvent(actor, 'supplier.invited', null, null, { supplier_id: supplier.id, programme_id: programme.id }, db);
    // An existing supplier joins from its own workspace (S1.6): it is told in-app, the anchor learns nothing more.
    if (!token) for (const user of await rows('SELECT id FROM users WHERE id=$1 OR org_ref=$2', [supplier.user_id ?? 0, `supplier-${supplier.id}`], db))
      await notify(String(user.id), 'New programme invitation', `${programme.anchor_name} invited you to join ${programme.name}. Review the programme terms to take part.`, null, actor, db);
    return { supplier, token, programme };
  });
  const delivery: Delivery = outcome.token ? await deliver(outcome.supplier, outcome.programme.anchor_name, outcome.token) : { channel: 'existing', sent: true };
  await rows('UPDATE programme_enrolments SET channel=$3,delivery_status=$4,updated_at=now() WHERE programme_id=$1 AND supplier_id=$2', [outcome.programme.id, outcome.supplier.id, delivery.channel, delivery.sent ? 'sent' : 'failed']).catch(() => undefined);
  return { id: String(outcome.supplier.id), delivery, ...(delivery.preview_url ? { preview_url: delivery.preview_url } : {}), ...(delivery.warning ? { warning: delivery.warning } : {}) };
}

/** What the invitation page shows: who is inviting, and the details already known so the supplier confirms rather than types. */
export async function invitationDetails(token: string) {
  const [supplier] = await rows('SELECT id,name,email,contact_phone,country,registration_number,user_id FROM suppliers WHERE invitation_token=$1 AND invitation_expires_at>now()', [digest(token)]);
  requireCondition(supplier, 404, 'This invitation is invalid or has expired');
  const [programme] = await rows('SELECT p.name AS programme,b.name AS anchor FROM programme_enrolments e JOIN programmes p ON p.id=e.programme_id JOIN buyers b ON b.id=p.buyer_id WHERE e.supplier_id=$1 ORDER BY e.created_at DESC LIMIT 1', [supplier.id]);
  return { name: supplier.name, email: supplier.email, phone: supplier.contact_phone, country: supplier.country, registration_number: supplier.registration_number, anchor: programme?.anchor ?? null, programme: programme?.programme ?? null };
}

/**
 * S1.3: the invited supplier creates its log-in. The first user is the supplier administrator; the organisation
 * moves from INVITED to REGISTERED and its programme links stay PENDING_ENROLMENT until verification and terms.
 */
export async function registerInvitedSupplier(input: { email: string; password: string; token: string; name?: string }, db: DB) {
  const [supplier] = await rows('SELECT * FROM suppliers WHERE invitation_token=$1 AND invitation_expires_at>now() FOR UPDATE', [digest(input.token)], db);
  requireCondition(supplier, 422, 'Invitation is invalid or expired');
  requireCondition(!supplier.email || supplier.email.toLowerCase() === input.email, 422, 'Use the email address the invitation was sent to');
  const hash = await hashPassword(input.password);
  let user: Row;
  if (supplier.user_id) {
    // Invitations issued before accounts were created at registration.
    const [account] = await rows('SELECT * FROM users WHERE id=$1 AND role=1 FOR UPDATE', [supplier.user_id], db);
    requireCondition(account, 422, 'Invitation is invalid');
    await revokeSessions(String(account.id), db);
    [user] = await rows("UPDATE users SET encrypted_password=$2,email_verified_at=now(),org_ref=$3,org_role=coalesce(org_role,'administrator'),provisioning_status='ACTIVE',updated_at=now() WHERE id=$1 RETURNING *", [account.id, hash, `supplier-${supplier.id}`], db);
  } else {
    const [taken] = await rows('SELECT id FROM users WHERE lower(email)=$1', [input.email], db);
    requireCondition(!taken, 409, 'An account with this email already exists. Sign in to accept the invitation.');
    [user] = await rows(`INSERT INTO users(email,name,encrypted_password,role,jti,portal_registration,email_verified_at,org_ref,org_role,provisioning_status,created_at,updated_at)
      VALUES($1,$2,$3,1,gen_random_uuid()::text,true,now(),$4,'administrator','ACTIVE',now(),now()) RETURNING *`, [input.email, input.name ?? null, hash, `supplier-${supplier.id}`], db);
    await rows('UPDATE suppliers SET user_id=$2,email=coalesce(email,$3),updated_at=now() WHERE id=$1', [supplier.id, user.id, input.email], db);
  }
  await rows('UPDATE suppliers SET invitation_token=NULL,invitation_expires_at=NULL,updated_at=now() WHERE id=$1', [supplier.id], db);
  const ref = `supplier-${supplier.id}`;
  if (!await lifecycle(ref, db)) await startLifecycle(ref, 'SUPPLIER', 'INVITED', null, 'Invitation issued before onboarding statuses existed', db);
  const state = await lifecycle(ref, db);
  if (state?.status === 'INVITED') await transition(ref, 'REGISTERED', { id: String(user.id), email: user.email, role: 'supplier_user', buyer_id: null }, 'Supplier administrator registered from the invitation', db);
  return user;
}

/** Whether a supplier may transact on a programme: its enrolment must be complete (S3.5). */
export async function enrolled(programmeId: string, supplierId: string, db?: DB) {
  const [row] = await rows("SELECT 1 FROM programme_enrolments WHERE programme_id=$1 AND supplier_id=$2 AND status='ENROLLED'", [programmeId, supplierId], db);
  return !!row;
}
