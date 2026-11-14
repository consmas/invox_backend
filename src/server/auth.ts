import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { NextRequest } from 'next/server';
import { rows, type DB, type Row } from './db';
import { ApiError, requireCondition } from './errors';
import { roles, type Role } from './validation';
import { currentRequest } from './context';

export const COOKIE_NAME = 'invoix_token';
export const SESSION_SECONDS = 60 * 60 * 2;
export type Actor = { id: string; email: string; role: Role; buyer_id: string | null; mfa_verified?: boolean;
  /** The person's role inside their organisation (SRS §13.5–13.7), e.g. approver, viewer, credit_officer. */
  org_role?: string | null;
  /** Present when a super administrator is acting on behalf of this account's organisation. */
  delegation?: import('./act-for').Delegation };
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const newToken = () => randomBytes(32).toString('hex');

// bcrypt is deliberately expensive; a small concurrency budget keeps credential floods from starving business traffic.
const hashing = { active: 0, waiting: [] as (() => void)[] };
const HASH_CONCURRENCY = Math.max(1, Number(process.env.BCRYPT_CONCURRENCY) || 4);
const HASH_QUEUE = Math.max(1, Number(process.env.BCRYPT_QUEUE) || 64);
async function bounded<T>(work: () => Promise<T>): Promise<T> {
  if (hashing.active >= HASH_CONCURRENCY) {
    requireCondition(hashing.waiting.length < HASH_QUEUE, 503, 'Sign-in is busy. Try again shortly.');
    await new Promise<void>(resolve => hashing.waiting.push(resolve));
  }
  hashing.active++;
  try { return await work(); } finally { hashing.active--; hashing.waiting.shift()?.(); }
}
export const hashPassword = (value: string) => bounded(() => bcrypt.hash(value, 12));
// Devise's default bcrypt hashes ($2a$/$2b$) remain valid, including legacy short passwords.
export const verifyPassword = (value: string, hash: string) => bounded(() => bcrypt.compare(value, hash));
export function publicUser(user: Row): Actor {
  return { id: String(user.id), email: user.email, role: roles[Number(user.role)], buyer_id: user.buyer_id == null ? null : String(user.buyer_id), org_role: user.org_role ?? null };
}
export function requestToken(req: NextRequest): string | undefined {
  return req.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1] ?? req.cookies.get(COOKIE_NAME)?.value;
}
export async function actorForToken(token?: string): Promise<Actor | null> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const [user] = await rows(`SELECT u.*,s.mfa_verified_at AS session_mfa_verified_at FROM app_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=$1 AND s.expires_at>now() AND s.user_jti=u.jti`, [digest(token)]);
  return user && !user.disabled_at ? { ...publicUser(user), mfa_verified: !!user.session_mfa_verified_at } : null;
}
export async function authenticate(req: NextRequest): Promise<Actor> {
  const user = await actorForToken(requestToken(req));
  if (!user) throw new ApiError(401, 'Authentication required');
  return user;
}
export function requireRole(actor: Actor, ...allowed: Role[]) {
  requireCondition(allowed.includes(actor.role), 403, 'Forbidden');
}
/** Operations accounts must complete authenticator enrolment and verification. Always on in production. */
export function privilegedMfaRequired(actor: Actor) {
  const enforced = process.env.NODE_ENV === 'production' || process.env.REQUIRE_OPERATIONS_MFA === 'true';
  return enforced && actor.role === 'platform_ops' && !actor.mfa_verified;
}
export async function createSession(user: Row, db: DB, mfaVerified = false): Promise<string> {
  const [current]=await rows('SELECT disabled_at FROM users WHERE id=$1 FOR UPDATE',[user.id],db);
  requireCondition(current&&!current.disabled_at,403,'Account access is disabled');
  const archived=await rows('SELECT 1 FROM users u LEFT JOIN buyers b ON b.id=u.buyer_id LEFT JOIN suppliers s ON s.user_id=u.id LEFT JOIN financier_profiles f ON f.user_id=u.id WHERE u.id=$1 AND (b.archived_at IS NOT NULL OR s.archived_at IS NOT NULL OR f.archived_at IS NOT NULL)',[user.id],db);
  requireCondition(!archived.length,403,'Organisation is archived');
  const token = newToken();
  await rows(`INSERT INTO app_sessions (token_hash,user_id,user_jti,expires_at,mfa_verified_at) VALUES ($1,$2,$3,now()+interval '2 hours',CASE WHEN $4 THEN now() END)`, [digest(token), user.id, user.jti, mfaVerified], db);
  return token;
}
/** Ends every session and pending sign-in ceremony: password changes and incident purges leave nothing usable. */
export async function revokeSessions(userId: string, db: DB) {
  await rows('DELETE FROM app_sessions WHERE user_id=$1', [userId], db);
  await rows('DELETE FROM portal_mfa_challenges WHERE user_id=$1', [userId], db);
  await rows('DELETE FROM trusted_devices WHERE user_id=$1', [userId], db);
  await rows('UPDATE users SET jti=$2, updated_at=now() WHERE id=$1', [userId, randomUUID()], db);
}
export function verifyOrigin(req: NextRequest) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const origin = req.headers.get('origin');
  const expected = new URL(process.env.APP_URL || req.url).origin;
  requireCondition(!origin || origin === expected, 403, 'Cross-origin request rejected');
  requireCondition(req.headers.get('sec-fetch-site') !== 'cross-site', 403, 'Cross-origin request rejected');
}
async function bump(key: string) {
  const [limit] = await rows(`INSERT INTO auth_rate_limits (key) VALUES ($1) ON CONFLICT (key) DO UPDATE SET
    attempts=CASE WHEN auth_rate_limits.window_start < now()-interval '15 minutes' THEN 1 ELSE auth_rate_limits.attempts+1 END,
    window_start=CASE WHEN auth_rate_limits.window_start < now()-interval '15 minutes' THEN now() ELSE auth_rate_limits.window_start END
    RETURNING attempts`, [digest(key)]);
  return Number(limit.attempts);
}
const budgets: Record<string, { ip: number; global: number }> = {
  login: { ip: 50, global: 2000 }, register: { ip: 10, global: 300 }, signup: { ip: 10, global: 300 }, contact: { ip: 10, global: 300 },
  reset: { ip: 20, global: 1000 }, 'reset-token': { ip: 20, global: 1000 }, mfa: { ip: 30, global: 2000 },
};
/**
 * Shared across workers and restarts. Each attempt counts against the account/challenge key, the caller's
 * network address (when CLIENT_IP_HEADER is configured) and an overall budget for that action, so rotating
 * identifiers cannot create unlimited capacity. Do not trust caller-supplied forwarding headers.
 */
export async function rateLimit(key: string, max = 10) {
  const kind = key.slice(0, key.indexOf(':'));
  const budget = budgets[kind];
  if (Math.random() < 0.01) await rows("DELETE FROM auth_rate_limits WHERE window_start < now()-interval '1 day'").catch(() => undefined);
  if (budget) {
    const ip = currentRequest()?.clientIp;
    if (ip && ip !== 'unconfigured') requireCondition(await bump(`${kind}-ip:${ip}`) <= budget.ip, 429, 'Too many attempts. Try again in 15 minutes.');
    requireCondition(await bump(`${kind}-global`) <= budget.global, 429, 'This service is receiving unusually many requests. Try again in 15 minutes.');
  }
  requireCondition(await bump(key) <= max, 429, 'Too many attempts. Try again in 15 minutes.');
}
