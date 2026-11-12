import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { NextRequest, NextResponse } from 'next/server';
import { rows, insert, update, transaction } from './db';
import { ApiError, requireCondition } from './errors';
import { COOKIE_NAME, SESSION_SECONDS, actorForToken, createSession, digest, hashPassword, newToken, publicUser, rateLimit, requestToken, revokeSessions, verifyPassword } from './auth';
import { email, password } from './validation';
import { coreSchema,databaseValues } from './fields';
import {challengeFor} from './portal-auth';
import { appUrl, requireMailConfiguration, sendLink } from './mail';

function withSession(response: NextResponse, token: string,remember=true) {
  response.cookies.set(COOKIE_NAME, token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge:remember?SESSION_SECONDS:undefined });
  return response;
}
export async function authRequest(req: NextRequest, action: string, input: Record<string, unknown>): Promise<NextResponse> {
  const body = input.user && typeof input.user === 'object' ? input.user : input;
  if (action === 'me' && req.method === 'GET') return NextResponse.json({ user: await actorForToken(requestToken(req)) });
  if (action === 'logout' && ['POST', 'DELETE'].includes(req.method)) {
    const token = requestToken(req);
    if (token) await rows('DELETE FROM app_sessions WHERE token_hash=$1', [digest(token)]);
    const res = NextResponse.json({ ok: true });
    res.cookies.set(COOKIE_NAME, '', { httpOnly:true, secure:process.env.NODE_ENV==='production', sameSite:'lax', path:'/', maxAge:0 });
    return res;
  }
  if (action === 'login' && req.method === 'POST') {
    const data = z.object({ email, password: z.string().min(1).max(128),remember:z.boolean().default(true) }).parse(body);
    await rateLimit(`login:${data.email}`);
    const [user] = await rows('SELECT * FROM users WHERE lower(email)=$1', [data.email]);
    const valid = !user?.disabled_at && user?.encrypted_password && await verifyPassword(data.password, user.encrypted_password);
    if (!user) await hashPassword('invalid-credentials-timing-padding');
    requireCondition(valid, 401, 'Invalid email or password');
    if(user.mfa_enrolled_at)return challengeFor(user,data.remember);
    const token = await transaction(async db => {
      const [locked] = await rows('SELECT * FROM users WHERE id=$1 FOR UPDATE', [user.id], db);
      requireCondition(locked && locked.encrypted_password === user.encrypted_password, 401, 'Invalid email or password');
      return createSession(locked, db);
    });
    return withSession(NextResponse.json({ ok: true, user: publicUser(user) }), token,data.remember);
  }
  if (action === 'signup' && req.method === 'POST') {
    const data = z.object({ email, password, password_confirmation:z.string().optional(), role:z.string().default('buyer_admin'),
      invite_token:z.string().optional(), name:z.string().optional(), registration_number:z.string().optional(), address:z.string().optional(),country:z.string().optional() }).parse(body);
    requireCondition(!data.password_confirmation || data.password === data.password_confirmation, 422, 'Passwords do not match');
    await rateLimit(`signup:${data.email}`, 5);
    const result = await transaction(async db => {
      const hash = await hashPassword(data.password);
      let user;
      if (data.invite_token) {
        requireCondition(data.role === 'supplier_user', 403, 'Invitation is for a supplier account');
        const [supplier] = await rows(`SELECT * FROM suppliers WHERE invitation_token=$1 AND invitation_expires_at>now() FOR UPDATE`, [digest(data.invite_token)], db);
        requireCondition(supplier && supplier.email.toLowerCase() === data.email, 422, 'Invitation is invalid or expired');
        const [account] = await rows('SELECT * FROM users WHERE id=$1 AND role=1 FOR UPDATE', [supplier.user_id], db);
        requireCondition(account, 422, 'Invitation is invalid');
        await revokeSessions(String(account.id), db);
        user = await update('users', String(account.id), { encrypted_password:hash,email_verified_at:new Date() }, db);
        await update('suppliers', String(supplier.id), { invitation_token:null, invitation_expires_at:null }, db);
      } else {
        requireCondition(data.role === 'buyer_admin', 403, 'Public signup is available only for a new buyer organization');
        const company = coreSchema('buyers').parse({ name:data.name, registration_number:data.registration_number, address:data.address, contact_email:data.email,country:data.country });
        const buyer = await insert('buyers', databaseValues('buyers',company), db);
        user = await insert('users', { email:data.email, encrypted_password:hash, role:0, buyer_id:buyer.id, jti:randomUUID(),portal_registration:true }, db);
      }
      return { user:publicUser(user), token:await createSession(user, db) };
    });
    return withSession(NextResponse.json({ ok:true, user:result.user }, { status:201 }), result.token);
  }
  if ((action === 'forgot-password' || action === 'password') && req.method === 'POST') {
    const data = z.object({ email }).parse(body);
    await rateLimit(`reset:${data.email}`, 5);
    await requireMailConfiguration();
    const base = appUrl();
    const [user] = await rows('SELECT id FROM users WHERE lower(email)=$1', [data.email]);
    let preview: { preview_url?: string } = {};
    if (user) {
      const token = newToken();
      await rows('UPDATE users SET reset_password_token=$2,reset_password_sent_at=now(),updated_at=now() WHERE id=$1', [user.id,digest(token)]);
      preview = await sendLink(data.email, 'Reset your Invoix password', `${base}/reset-password?token=${token}`);
    }
    return NextResponse.json({ ok:true, message:'If the account exists, a password reset link has been sent.', ...preview });
  }
  if ((action === 'reset-password' && req.method === 'POST') || action === 'password' && ['PATCH','PUT'].includes(req.method)) {
    const raw=body as Record<string,unknown>;
    const data = z.object({ token:z.string().min(1).max(256), password, password_confirmation:z.string().optional() }).parse({...raw,token:raw.token??raw.reset_password_token});
    requireCondition(!data.password_confirmation || data.password_confirmation === data.password, 422, 'Passwords do not match');
    await rateLimit(`reset-token:${digest(data.token)}`, 5);
    await transaction(async db => {
      const [user] = await rows(`SELECT * FROM users WHERE reset_password_token=$1 AND reset_password_sent_at>now()-interval '6 hours' FOR UPDATE`, [digest(data.token)], db);
      requireCondition(user, 422, 'Reset link is invalid or expired');
      await revokeSessions(String(user.id), db);
      await update('users', String(user.id), { encrypted_password:await hashPassword(data.password),reset_password_token:null,reset_password_sent_at:null }, db);
    });
    return NextResponse.json({ ok:true });
  }
  if (action === 'change-password' && req.method === 'POST') {
    const actor = await actorForToken(requestToken(req));
    requireCondition(actor, 401, 'Authentication required');
    const raw = body as Record<string, unknown>;
    const data = z.object({ current_password:z.string().min(1).max(128), password, password_confirmation:z.string() }).parse(raw);
    requireCondition(data.password === data.password_confirmation, 422, 'Passwords do not match');
    requireCondition(data.password !== data.current_password, 422, 'Choose a password different from the current one');
    await rateLimit(`change-password:${actor.id}`, 5);
    const token = await transaction(async db => {
      const [user] = await rows('SELECT * FROM users WHERE id=$1 FOR UPDATE', [actor.id], db);
      requireCondition(user?.encrypted_password && await verifyPassword(data.current_password, user.encrypted_password), 422, 'Current password is incorrect');
      // Every other session is signed out; this browser receives a fresh session.
      await revokeSessions(String(user.id), db);
      const updated = await update('users', String(user.id), { encrypted_password:await hashPassword(data.password) }, db);
      return createSession(updated, db);
    });
    return withSession(NextResponse.json({ ok:true }), token);
  }
  if (action === 'invite' && req.method === 'GET') {
    const token = req.nextUrl.searchParams.get('token') ?? '';
    const [supplier] = await rows(`SELECT name,email FROM suppliers WHERE invitation_token=$1 AND invitation_expires_at>now()`, [digest(token)]);
    requireCondition(supplier, 404, 'Invitation is invalid or expired');
    return NextResponse.json(supplier);
  }
  throw new ApiError(['login','logout','signup','me','password','forgot-password','reset-password','invite','change-password'].includes(action) ? 405 : 404, 'Not found or method not allowed');
}
