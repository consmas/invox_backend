import type { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { type Actor, publicUser, privilegedMfaRequired, digest, newToken } from './auth';
import { email } from './validation';
import { rows, type DB, type Row } from './db';
import { requireCondition } from './errors';
import { sendNotice, sendLink, appUrl } from './mail';

/**
 * Super administrators may act on behalf of an organisation (or of a registered account that has not yet
 * created its organisation). The request then runs with that organisation's own scope and lifecycle rules,
 * while the administrator stays recorded as the person who acted. Every change is written to the
 * organisation's administration log and every user of the organisation is notified.
 */
export const ACT_FOR_COOKIE = 'invox_act_for';
export const ACT_FOR_SECONDS = 60 * 60 * 2;
export type Delegation = { admin_id: string; admin_email: string; admin_name: string | null; target: string; target_name: string; reason: string };

const targetPattern = /^(buyer|supplier|financier|user)-[1-9]\d{0,17}$/;
export const actForInput = z.object({
  target: z.string().regex(targetPattern, 'Choose an organisation'),
  reason: z.string().trim().min(10, 'State why you are acting for this organisation (at least 10 characters)').max(500),
});
type CookieValue = { t: string; r: string; a: string };

export function encodeActFor(target: string, reason: string, adminId: string) {
  return Buffer.from(JSON.stringify({ t: target, r: reason, a: adminId } satisfies CookieValue)).toString('base64url');
}
/** The act-for cookie is honoured only for the administrator who started it. */
function readCookie(req: NextRequest, admin: Actor): { target: string; reason: string } | null {
  const raw = req.cookies.get(ACT_FOR_COOKIE)?.value;
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as CookieValue;
    if (value.a !== admin.id) return null;
    const parsed = actForInput.safeParse({ target: value.t, reason: value.r });
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
export function setActForCookie(res: NextResponse, value: string | null) {
  if (value === null) res.cookies.delete(ACT_FOR_COOKIE);
  else res.cookies.set(ACT_FOR_COOKIE, value, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: ACT_FOR_SECONDS });
  return res;
}

export async function isSuperAdmin(actor: Actor, db?: DB) {
  if (actor.role !== 'platform_ops' || actor.delegation) return false;
  const [user] = await rows('SELECT super_admin FROM users WHERE id=$1 AND disabled_at IS NULL', [actor.id], db);
  return !!user?.super_admin;
}
export async function requireSuperAdmin(actor: Actor, db?: DB) {
  requireCondition(await isSuperAdmin(actor, db), 403, 'Only a super administrator can act on behalf of an organisation');
  requireCondition(!privilegedMfaRequired(actor), 403, 'Verify your authenticator before acting on behalf of an organisation');
}

type Target = { account: Row; name: string; recipients: string[]; home: string };
/** Resolves the organisation's acting account: its earliest active user (an invited user counts as active). */
export async function resolveTarget(target: string, db?: DB, starting = false): Promise<Target> {
  const [kind, key] = target.split('-');
  const pick = (users: Row[]) => users.find(u => !String(u.encrypted_password ?? '').startsWith('!')) ?? users[0];
  if (kind === 'buyer') {
    const [buyer] = await rows('SELECT id,name,archived_at FROM buyers WHERE id=$1', [key], db);
    requireCondition(buyer, 404, 'Organisation not found');
    requireCondition(!buyer.archived_at, 409, 'Restore the organisation before acting for it');
    const users = await rows('SELECT * FROM users WHERE buyer_id=$1 AND role=0 AND disabled_at IS NULL ORDER BY id', [key], db);
    requireCondition(users.length, 409, 'Add an active user to this organisation before acting for it');
    return { account: pick(users), name: buyer.name, recipients: users.map(u => String(u.id)), home: '/buyer' };
  }
  if (kind === 'supplier') {
    const [supplier] = await rows('SELECT s.name,s.archived_at,u.* FROM suppliers s LEFT JOIN users u ON u.id=s.user_id AND u.disabled_at IS NULL WHERE s.id=$1', [key], db);
    requireCondition(supplier, 404, 'Organisation not found');
    requireCondition(!supplier.archived_at, 409, 'Restore the organisation before acting for it');
    requireCondition(supplier.id, 409, 'Add an active user to this organisation before acting for it');
    return { account: supplier, name: supplier.name, recipients: [String(supplier.id)], home: '/supplier' };
  }
  if (kind === 'financier') {
    const [financier] = await rows('SELECT f.name AS org_name,f.archived_at,u.* FROM financier_profiles f JOIN users u ON u.id=f.user_id WHERE f.user_id=$1 AND u.role=3', [key], db);
    requireCondition(financier, 404, 'Organisation not found');
    requireCondition(!financier.archived_at && !financier.disabled_at, 409, 'Restore the organisation before acting for it');
    return { account: financier, name: financier.org_name, recipients: [String(financier.id)], home: '/financier' };
  }
  // A registered account that has not created its organisation yet: the administrator completes onboarding.
  const [user] = await rows('SELECT * FROM users WHERE id=$1 AND role<>2 AND disabled_at IS NULL', [key], db);
  requireCondition(user && user.portal_registration, 404, 'Registration not found');
  const linked = await rows('SELECT 1 FROM users u LEFT JOIN suppliers s ON s.user_id=u.id LEFT JOIN financier_profiles f ON f.user_id=u.id WHERE u.id=$1 AND (u.buyer_id IS NOT NULL OR s.id IS NOT NULL OR f.user_id IS NOT NULL)', [key], db);
  // Once onboarding has created the organisation, an open session continues; new sessions target the organisation.
  requireCondition(!starting || !linked.length, 409, 'This account already has an organisation; act for the organisation instead');
  return { account: user, name: user.name ?? user.email, recipients: [String(user.id)], home: '/onboarding' };
}

/** The organisation-scoped actor for a request carrying a valid act-for cookie, or null to proceed as the administrator. */
export async function delegatedActor(req: NextRequest, admin: Actor): Promise<Actor | null> {
  const acting = readCookie(req, admin);
  if (!acting) return null;
  await requireSuperAdmin(admin);
  const target = await resolveTarget(acting.target);
  const [me] = await rows('SELECT name FROM users WHERE id=$1', [admin.id]);
  return { ...publicUser(target.account), mfa_verified: true,
    delegation: { admin_id: admin.id, admin_email: admin.email, admin_name: me?.name ?? null, target: acting.target, target_name: target.name, reason: acting.reason } };
}

/** The person accountable for an action: the administrator when acting for an organisation. */
export const responsibleId = (actor: Actor) => actor.delegation?.admin_id ?? actor.id;

/**
 * Two-person rules apply to the person, not the account: an administrator may not approve, verify or
 * confirm a record they prepared while acting for the organisation.
 */
export async function preparedOnBehalfBy(adminId: string, recordType: string, recordId: string, db?: DB) {
  const singular = recordType.replace(/s$/, '');
  const portal = await rows(`SELECT 1 FROM portal_events WHERE acting_admin_id=$1 AND (event LIKE $2 OR event LIKE $3)
    AND (details->>'record_id'=$4 OR details->>$5=$4 OR details->>'org_ref'=$4) LIMIT 1`, [adminId, `${recordType}.%`, `${singular}.%`, recordId, `${singular}_id`], db);
  if (portal.length) return true;
  return (await rows('SELECT 1 FROM audit_events WHERE acting_admin_id=$1 AND record_type=$2 AND record_id::text=$3 LIMIT 1', [adminId, singular, recordId], db)).length > 0;
}

const verbs: Record<string, string> = { POST: 'Created', PATCH: 'Updated', PUT: 'Updated', DELETE: 'Removed' };
const words = (value: string) => value.replace(/[-_]/g, ' ');
/** A plain-language description of the request for the log and the notification. */
export function describe(method: string, path: string[]) {
  let segments = path[0] === 'v1' ? path.slice(1) : path;
  if (segments[0] === 'portal-auth') return 'Submitted the organisation’s verification (KYC) details';
  if (segments[0] === 'portal' && ['manage', 'modules'].includes(segments[1])) segments = segments.slice(2);
  else if (segments[0] === 'portal' || segments[0] === 'controls') segments = segments.slice(1);
  if (segments[0] === 'documents') return 'Uploaded a document';
  const [resource = 'record', recordId, action, ...rest] = segments;
  const nested = action && !/^\d+$/.test(action) ? action : undefined;
  const subject = `${words(resource).replace(/s$/, '')}${recordId && /^\d+$/.test(recordId) ? ` #${recordId}` : ''}`;
  if (nested && rest.length) return `${words(rest[rest.length - 1] ?? nested)} on ${words(nested)} for ${subject}`;
  if (nested) return `${words(nested).replace(/^./, c => c.toUpperCase())} ${subject}`;
  if (recordId && !/^\d+$/.test(recordId)) return `${(verbs[method] ?? 'Changed')} ${subject} (${words(recordId)})`;
  return `${verbs[method] ?? 'Changed'} ${subject}`;
}

/** Writes the administration log entry and notifies every user of the organisation, inside the action's transaction. */
export async function recordDelegatedAction(actor: Actor, method: string, path: string[], result: { status: number; data?: unknown }, db?: DB) {
  const delegation = actor.delegation!;
  const label = describe(method, path);
  const data = result.data && typeof result.data === 'object' ? result.data as Row : {};
  const invoiceId = path.includes('invoices') ? path[path.indexOf('invoices') + 1] : typeof data.invoice_id === 'string' || typeof data.invoice_id === 'number' ? String(data.invoice_id) : null;
  const relatedInvoice = invoiceId && /^[1-9]\d{0,17}$/.test(invoiceId) ? invoiceId : null;
  await rows('INSERT INTO organisation_admin_events(org_ref,actor_id,operation,reason,details) VALUES($1,$2,$3,$4,$5)', [delegation.target, delegation.admin_id, `${method} ${path.join('/')}`, delegation.reason,
    JSON.stringify({ label, status: result.status, record_id: data.id ?? null, invoice_id: relatedInvoice, on_behalf_of_user_id: actor.id })], db);
  const target = await resolveTarget(delegation.target, db).catch(() => null);
  const recipients = target?.recipients ?? [actor.id];
  const who = delegation.admin_name ?? delegation.admin_email;
  const body = `${who} (INVOX administrator) acted on behalf of ${delegation.target_name}: ${label}. Reason: ${delegation.reason}`;
  for (const userId of recipients)
    await rows("INSERT INTO notifications(user_id,event_type,channel,subject,body,related_resource,related_id,status,created_by) VALUES($1,'admin_on_behalf','in_app',$2,$3,'invoices',$4,'delivered',$5)",
      [userId, 'An administrator acted on your behalf', body, relatedInvoice, delegation.admin_id], db);
  return { recipients, subject: 'An INVOX administrator acted on your behalf', body };
}

/** Best-effort email copies after the transaction has committed; in-app notifications are the record. */
export async function emailRecipients(userIds: string[], subject: string, body: string) {
  if (!userIds.length) return;
  const users = await rows('SELECT email FROM users WHERE id=ANY($1::bigint[]) AND disabled_at IS NULL', [userIds]).catch(() => []);
  for (const user of users) await sendNotice(user.email, subject, body).catch(error => console.error('Notice email failed', (error as Error).message));
}

/** Starts or ends an act-for session; both are logged and the organisation is told. */
export async function startActing(admin: Actor, input: unknown, db: DB) {
  await requireSuperAdmin(admin, db);
  const data = actForInput.parse(input);
  const target = await resolveTarget(data.target, db, true);
  const [me] = await rows('SELECT name FROM users WHERE id=$1', [admin.id], db);
  const actor: Actor = { ...publicUser(target.account), delegation: { admin_id: admin.id, admin_email: admin.email, admin_name: me?.name ?? null, target: data.target, target_name: target.name, reason: data.reason } };
  await rows('INSERT INTO organisation_admin_events(org_ref,actor_id,operation,reason,details) VALUES($1,$2,$3,$4,$5)', [data.target, admin.id, 'act_for.started', data.reason, JSON.stringify({ label: 'Started working on behalf of the organisation', on_behalf_of_user_id: target.account.id })], db);
  const who = me?.name ?? admin.email;
  const body = `${who} (INVOX administrator) started working on behalf of ${target.name}. Reason: ${data.reason}. Each change they make will be notified to you.`;
  for (const userId of target.recipients)
    await rows("INSERT INTO notifications(user_id,event_type,channel,subject,body,related_resource,status,created_by) VALUES($1,'admin_on_behalf','in_app',$2,$3,'organisations','delivered',$4)", [userId, 'An administrator is working on your behalf', body, admin.id], db);
  return { ref: data.target, actor, target, cookie: encodeActFor(data.target, data.reason, admin.id), notice: { recipients: target.recipients, subject: 'An INVOX administrator is working on your behalf', body } };
}

export const newOrganisationInput = z.object({
  name: z.string().trim().min(2, 'Enter the representative’s full name').max(200),
  email,
  reason: actForInput.shape.reason,
});
/**
 * Onboards an organisation from scratch: creates its representative's account (no usable password yet) and opens
 * an act-for session on it, so the administrator completes the same onboarding wizard and KYC submission an
 * organisation would. Approval still needs a different operator.
 */
export async function registerOrganisation(admin: Actor, input: unknown, db: DB) {
  await requireSuperAdmin(admin, db);
  const data = newOrganisationInput.parse(input);
  const [existing] = await rows('SELECT id FROM users WHERE lower(email)=$1', [data.email], db);
  requireCondition(!existing, 409, 'An account with this email already exists. If it is waiting for onboarding, use Complete onboarding instead.');
  const [user] = await rows("INSERT INTO users(email,name,encrypted_password,role,jti,portal_registration,created_at,updated_at) VALUES($1,$2,'!invitation-pending',0,$3,true,now(),now()) RETURNING id", [data.email, data.name, randomUUID()], db);
  await rows('INSERT INTO organisation_admin_events(org_ref,actor_id,operation,reason,details) VALUES($1,$2,$3,$4,$5)', [`user-${user.id}`, admin.id, 'organisation.registered', data.reason, JSON.stringify({ label: 'Registered the organisation’s representative account', on_behalf_of_user_id: user.id })], db);
  return startActing(admin, { target: `user-${user.id}`, reason: data.reason }, db);
}
/**
 * Emails the representative a link to choose their password (valid 6 hours; afterwards "Forgot password" issues a
 * new one). Delivery problems never undo the onboarding: the result says whether the email went out.
 */
export async function sendAccountSetup(userId: string): Promise<{ sent: boolean; preview_url?: string; warning?: string }> {
  try {
    const [user] = await rows('SELECT email FROM users WHERE id=$1', [userId]);
    const token = newToken();
    await rows('UPDATE users SET reset_password_token=$2,reset_password_sent_at=now(),updated_at=now() WHERE id=$1', [userId, digest(token)]);
    const delivery = await sendLink(user.email, 'Set up your INVOX account', `${appUrl()}/reset-password?token=${token}`);
    return { sent: true, ...delivery };
  } catch (error) {
    return { sent: false, warning: `The account was created but the set-up email could not be sent (${(error as Error).message}). The representative can use “Forgot password” on the sign-in page.` };
  }
}
