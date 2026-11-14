import { digest } from '../auth';
import { rows } from '../db';
import { requireCondition } from '../errors';

/**
 * Invitations for pre-provisioned users (A4.9, F3.5): single-use and time-limited. Releasing them is gated on the
 * programme or facility being live (increment 3); accepting one validates the token and that it is unused, unexpired
 * and still matches a provisioned account.
 */
export async function invitationFor(token: string) {
  requireCondition(/^[a-f0-9]{64}$/.test(token), 404, 'This invitation is invalid or has expired');
  const [invitation] = await rows(`SELECT i.*,u.email,u.name,u.encrypted_password,u.provisioning_status FROM user_invitations i JOIN users u ON u.id=i.user_id
    WHERE i.token_hash=$1 AND i.accepted_at IS NULL AND i.expires_at>now() AND u.disabled_at IS NULL`, [digest(token)]);
  requireCondition(invitation && String(invitation.encrypted_password).startsWith('!'), 404, 'This invitation is invalid or has expired');
  const [kind, key] = String(invitation.org_ref).split('-');
  const [org] = kind === 'buyer' ? await rows('SELECT name FROM buyers WHERE id=$1', [key]) : await rows('SELECT name FROM financier_profiles WHERE user_id=$1', [key]);
  return { invitation, organisation: org?.name ?? null };
}
