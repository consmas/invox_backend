import type { NextRequest, NextResponse } from 'next/server';
import { digest, newToken } from './auth';
import { rows, type DB, type Row } from './db';

/**
 * "Trust this device": after a successful authenticator code, a browser may skip the code on later sign-ins for
 * TRUSTED_DEVICE_DAYS (default 30, 0 turns the feature off). The password is still required every time, so the
 * device token is a second factor, never a replacement for the first. Only its hash is stored.
 */
export const TRUSTED_DEVICE_COOKIE = 'invox_trusted_device';
export function trustedDeviceDays() {
  const raw = process.env.TRUSTED_DEVICE_DAYS;
  const days = raw === undefined || raw === '' ? 30 : Number(raw);
  return Number.isInteger(days) && days >= 0 && days <= 90 ? days : 30;
}
const TOKEN = /^[a-f0-9]{64}$/;

/** True when this browser holds a current trusted-device token for the account and its present credentials. */
export async function isTrustedDevice(req: NextRequest, user: Row, db?: DB): Promise<boolean> {
  const token = req.cookies.get(TRUSTED_DEVICE_COOKIE)?.value;
  if (!trustedDeviceDays() || !token || !TOKEN.test(token)) return false;
  // Bound to the credential epoch (jti) and to the current authenticator: re-enrolling ends earlier trust.
  const [device] = await rows(`UPDATE trusted_devices d SET last_used_at=now() FROM users u
    WHERE d.token_hash=$1 AND d.user_id=$2 AND u.id=d.user_id AND d.user_jti=u.jti AND d.expires_at>now()
      AND u.mfa_enrolled_at IS NOT NULL AND d.created_at>=u.mfa_enrolled_at RETURNING d.id`, [digest(token), user.id], db);
  return !!device;
}

/** Records a newly trusted browser and sets its cookie on the response. */
export async function trustDevice(res: NextResponse, req: NextRequest, user: { id: unknown; jti: unknown }, db?: DB) {
  const days = trustedDeviceDays();
  if (!days) return res;
  const token = newToken();
  const label = (req.headers.get('user-agent') ?? '').replace(/[\x00-\x1f]/g, '').slice(0, 200) || null;
  await rows(`INSERT INTO trusted_devices(token_hash,user_id,user_jti,label,expires_at) VALUES($1,$2,$3,$4,now()+make_interval(days => $5))`, [digest(token), user.id, user.jti, label, days], db);
  res.cookies.set(TRUSTED_DEVICE_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: days * 86400 });
  return res;
}

export async function trustedDeviceCount(userId: string) {
  const [row] = await rows('SELECT count(*)::int AS count FROM trusted_devices WHERE user_id=$1 AND expires_at>now()', [userId]);
  return Number(row?.count ?? 0);
}
export async function forgetTrustedDevices(userId: string, db?: DB) {
  await rows('DELETE FROM trusted_devices WHERE user_id=$1', [userId], db);
}
