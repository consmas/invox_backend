import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { NextRequest } from 'next/server';
import { rows, type DB, type Row } from './db';
import { ApiError, requireCondition } from './errors';
import { roles, type Role } from './validation';

export const COOKIE_NAME = 'invoix_token';
export const SESSION_SECONDS = 60 * 60 * 2;
export type Actor = { id: string; email: string; role: Role; buyer_id: string | null };
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const newToken = () => randomBytes(32).toString('hex');
export const hashPassword = (value: string) => bcrypt.hash(value, 12);
// Devise's default bcrypt hashes ($2a$/$2b$) remain valid, including legacy short passwords.
export const verifyPassword = (value: string, hash: string) => bcrypt.compare(value, hash);
export function publicUser(user: Row): Actor {
  return { id: String(user.id), email: user.email, role: roles[Number(user.role)], buyer_id: user.buyer_id == null ? null : String(user.buyer_id) };
}
export function requestToken(req: NextRequest): string | undefined {
  return req.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1] ?? req.cookies.get(COOKIE_NAME)?.value;
}
export async function actorForToken(token?: string): Promise<Actor | null> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const [user] = await rows(`SELECT u.* FROM app_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=$1 AND s.expires_at>now() AND s.user_jti=u.jti`, [digest(token)]);
  return user && !user.disabled_at ? publicUser(user) : null;
}
export async function authenticate(req: NextRequest): Promise<Actor> {
  const user = await actorForToken(requestToken(req));
  if (!user) throw new ApiError(401, 'Authentication required');
  return user;
}
export function requireRole(actor: Actor, ...allowed: Role[]) {
  requireCondition(allowed.includes(actor.role), 403, 'Forbidden');
}
export async function createSession(user: Row, db: DB): Promise<string> {
  const [current]=await rows('SELECT disabled_at FROM users WHERE id=$1 FOR UPDATE',[user.id],db);
  requireCondition(current&&!current.disabled_at,403,'Account access is disabled');
  const archived=await rows('SELECT 1 FROM users u LEFT JOIN buyers b ON b.id=u.buyer_id LEFT JOIN suppliers s ON s.user_id=u.id LEFT JOIN financier_profiles f ON f.user_id=u.id WHERE u.id=$1 AND (b.archived_at IS NOT NULL OR s.archived_at IS NOT NULL OR f.archived_at IS NOT NULL)',[user.id],db);
  requireCondition(!archived.length,403,'Organisation is archived');
  const token = newToken();
  await rows(`INSERT INTO app_sessions (token_hash,user_id,user_jti,expires_at) VALUES ($1,$2,$3,now()+interval '2 hours')`, [digest(token), user.id, user.jti], db);
  return token;
}
export async function revokeSessions(userId: string, db: DB) {
  await rows('DELETE FROM app_sessions WHERE user_id=$1', [userId], db);
  await rows('UPDATE users SET jti=$2, updated_at=now() WHERE id=$1', [userId, randomUUID()], db);
}
export function verifyOrigin(req: NextRequest) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const origin = req.headers.get('origin');
  const expected = new URL(process.env.APP_URL || req.url).origin;
  requireCondition(!origin || origin === expected, 403, 'Cross-origin request rejected');
  requireCondition(req.headers.get('sec-fetch-site') !== 'cross-site', 403, 'Cross-origin request rejected');
}
export async function rateLimit(key: string, max = 10) {
  // Shared across workers and restarts. Do not trust caller-supplied forwarding headers.
  const [limit] = await rows(`INSERT INTO auth_rate_limits (key) VALUES ($1) ON CONFLICT (key) DO UPDATE SET
    attempts=CASE WHEN auth_rate_limits.window_start < now()-interval '15 minutes' THEN 1 ELSE auth_rate_limits.attempts+1 END,
    window_start=CASE WHEN auth_rate_limits.window_start < now()-interval '15 minutes' THEN now() ELSE auth_rate_limits.window_start END
    RETURNING attempts`, [digest(key)]);
  requireCondition(limit.attempts <= max, 429, 'Too many attempts. Try again in 15 minutes.');
}
