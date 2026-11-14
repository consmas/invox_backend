import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticate, verifyOrigin, privilegedMfaRequired, actorForToken, requestToken, type Actor } from './auth';
import { ACT_FOR_COOKIE, delegatedActor, recordDelegatedAction, emailRecipients, startActing, setActForCookie, registerOrganisation, sendAccountSetup } from './act-for';
import { authRequest } from './auth-routes';
import { ApiError } from './errors';
import { resourceRequest } from './resources';
import { rows, transaction } from './db';
import { financeRequest } from './finance';
import {portalRequest,sessionData} from './portal';
import {portalAuth} from './portal-auth';
import { definitions,controlRecords,lookup } from './control-records';
import { withRequest } from './context';

const JSON_LIMIT = 1024 * 1024;
/** Reads at most `limit` bytes; a missing or false Content-Length cannot make the server buffer more. */
export async function readLimited(req: NextRequest, limit: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > limit) throw new ApiError(413, 'Request body is too large');
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => undefined); throw new ApiError(413, 'Request body is too large'); }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}
/** Headers for every API response, including errors; the browser must never frame, sniff or cache API data. */
export function secureHeaders(res: NextResponse) {
  res.headers.set('Cache-Control','no-store');
  res.headers.set('X-Content-Type-Options','nosniff');
  res.headers.set('X-Frame-Options','DENY');
  res.headers.set('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'; sandbox");
  res.headers.set('Referrer-Policy','no-referrer');
  res.headers.set('Cross-Origin-Resource-Policy','same-origin');
  if (process.env.NODE_ENV === 'production') res.headers.set('Strict-Transport-Security','max-age=31536000; includeSubDomains');
  return res;
}
/** Paths an account without an approved organisation (or without any buyer membership) may use: its own onboarding only. */
function onboardingPath(method: string, path: string[]) {
  const route = `${method} ${path.join('/')}`;
  return ['GET portal/session','GET portal/bootstrap','PATCH portal/profile','POST portal/notifications'].includes(route) || method === 'GET' && path[0] === 'field-definitions';
}
async function gate(actor: Actor, method: string, path: string[]) {
  if (privilegedMfaRequired(actor)) {
    if (method === 'GET' && path.join('/') === 'portal/session') return;
    throw new ApiError(403, 'Operations accounts must enrol and verify an authenticator before using the workspace');
  }
  if (actor.role === 'platform_ops') return;
  // Read-only people (anchor viewers, funder auditors) can look but never change anything, whatever the screen offers.
  if (['viewer', 'auditor'].includes(actor.org_role ?? '') && !['GET', 'HEAD'].includes(method) && !['POST portal/notifications', 'PATCH portal/profile'].includes(`${method} ${path.join('/')}`))
    throw new ApiError(403, 'Your access is read-only');
  // Fail closed: a buyer role with no active buyer membership is never treated as an unrestricted scope.
  const orphaned = actor.role === 'buyer_admin' && !actor.buyer_id;
  if (!orphaned && onboardingPath(method, path)) return;
  const session = await sessionData(actor);
  if ((orphaned || session.needs_onboarding) && !onboardingPath(method, path))
    throw new ApiError(403, orphaned && !session.needs_onboarding ? 'Your account is not linked to an active organisation' : 'Complete organisation verification before using transaction actions');
}
function transient(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String(error.code) : '';
  const message = 'message' in error ? String(error.message) : '';
  return ['57014','55P03','53300','40001','40P01','57P01','ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOTFOUND','EAI_AGAIN'].includes(code) || /timeout exceeded when trying to connect|connection timeout/i.test(message);
}

async function route(actor: Actor, req: NextRequest, path: string[], body: Record<string, unknown>): Promise<{status?:number;data?:unknown}> {
  if(req.headers.has('idempotency-key'))body.idempotency_key=req.headers.get('idempotency-key');
  const financial=['agreements','fundings','repayments'].includes(path[0])||path[0]==='invoices'&&['financials','agreements','fundings','repayments'].includes(path[2]);
  return path[0]==='portal'?await portalRequest(actor,req.method,path,body):path[0]==='field-definitions'&&req.method==='GET'?await definitions(actor,path)
    :path[0]==='lookups'&&path.length===2&&req.method==='GET'?await lookup(actor,path[1])
    :path[0]==='controls'?await controlRecords(actor,req.method,path,body)
    :financial?await financeRequest(actor,req.method,path,body):await resourceRequest(actor,req.method,path,body);
}
/** The organisation-scoped actor when a super administrator has an act-for session open, otherwise null. */
async function actingActor(req: NextRequest): Promise<Actor | null> {
  if (!req.cookies.get(ACT_FOR_COOKIE)) return null;
  const admin = await actorForToken(requestToken(req));
  return admin ? delegatedActor(req, admin) : null;
}
/** Starts (POST portal/act-for) or ends (POST portal/act-for/stop) acting on behalf of an organisation. */
async function actFor(req: NextRequest, path: string[], body: Record<string, unknown>): Promise<NextResponse> {
  requireMethod(req, 'POST');
  const admin = await authenticate(req);
  if (path[2] === 'stop' && path.length === 3) {
    const res = NextResponse.json({ stopped: true });
    const acting = await delegatedActor(req, admin).catch(() => null);
    if (acting?.delegation) await rows('INSERT INTO organisation_admin_events(org_ref,actor_id,operation,reason,details) VALUES($1,$2,$3,$4,$5)', [acting.delegation.target, admin.id, 'act_for.stopped', acting.delegation.reason, JSON.stringify({ label: 'Stopped working on behalf of the organisation' })]);
    return setActForCookie(res, null);
  }
  if (path[2] === 'new-organisation' && path.length === 3) {
    const started = await transaction(db => registerOrganisation(admin, body, db));
    const setup = await sendAccountSetup(String(started.target.account.id));
    await emailRecipients(started.notice.recipients, started.notice.subject, started.notice.body);
    return setActForCookie(NextResponse.json({ target: started.ref, name: started.target.name, role: started.actor.role, home: started.target.home, setup }, { status: 201 }), started.cookie);
  }
  if (path.length !== 2) throw new ApiError(404, 'Not found');
  const started = await transaction(db => startActing(admin, body, db));
  await emailRecipients(started.notice.recipients, started.notice.subject, started.notice.body);
  return setActForCookie(NextResponse.json({ target: started.ref, name: started.target.name, role: started.actor.role, home: started.target.home }, { status: 201 }), started.cookie);
}
function requireMethod(req: NextRequest, method: string) { if (req.method !== method) throw new ApiError(405, 'Method not allowed'); }
/**
 * Runs a request as the organisation, under its own scope and lifecycle rules. Changes commit together with
 * the administration log entry and the organisation's notifications; read-only requests are not notified.
 */
async function onBehalf(req: NextRequest, actor: Actor, path: string[], body: Record<string, unknown>): Promise<NextResponse> {
  const key = path.slice(0, 2).join('/');
  if (key === 'portal/notifications' && req.method === 'POST') return NextResponse.json({ ok: true, unchanged: true });
  if (key === 'portal/profile' || path[0] === 'portal-auth' && path[1] !== 'onboarding')
    throw new ApiError(403, 'Personal account settings belong to the organisation’s users and cannot be changed on their behalf');
  const write = !['GET', 'HEAD'].includes(req.method);
  const run = async (): Promise<{ res: NextResponse; status: number; data?: unknown }> => {
    if (path[0] === 'portal-auth') {
      const res = await portalAuth(req, path[1], body, actor);
      return { res, status: res.status, data: res.status < 300 ? await res.clone().json().catch(() => undefined) : undefined };
    }
    await gate(actor, req.method, path);
    const result = await route(actor, req, path, body);
    const status = result.status ?? 200;
    return { res: status === 204 ? new NextResponse(null, { status: 204 }) : NextResponse.json(result.data, { status }), status, data: result.data };
  };
  if (!write) return (await run()).res;
  const outcome = await transaction(async db => {
    const done = await run();
    const notice = done.status < 400 ? await recordDelegatedAction(actor, req.method, path, { status: done.status, data: done.data }, db) : null;
    return { ...done, notice };
  });
  if (outcome.notice) await emailRecipients(outcome.notice.recipients, outcome.notice.subject, outcome.notice.body);
  return outcome.res;
}

export function handleRequest(req: NextRequest, path: string[]): Promise<NextResponse> {
  return withRequest(req, () => dispatch(req, path));
}
async function dispatch(req: NextRequest, path: string[]): Promise<NextResponse> {
  try {
    verifyOrigin(req);
    if (path[0] === 'v1') path = path.slice(1);
    let body: Record<string, unknown> = {};
    if (['POST','PATCH','PUT'].includes(req.method)) {
      const text = new TextDecoder().decode(await readLimited(req, JSON_LIMIT));
      if (text) {
        try { body = z.record(z.string(),z.unknown()).parse(JSON.parse(text)); }
        catch { throw new ApiError(400, 'Expected a JSON object'); }
      }
    }
    let res: NextResponse;
    const actForRoute = path[0]==='portal' && path[1]==='act-for';
    let acting: Actor | null = null;
    let endActing = false;
    // A session that is no longer valid (organisation archived, access revoked) must never lock the administrator
    // out of signing out or of their own workspace: it is ended and the administrator is told why.
    if (!actForRoute) try { acting = await actingActor(req); } catch (error) {
      if (!(error instanceof ApiError) || error.status === 401) throw error;
      if (path[0] !== 'auth') return secureHeaders(setActForCookie(NextResponse.json({ error: `Your session acting for the organisation has ended: ${error.message}`, errors: [error.message], acting_ended: true }, { status: error.status }), null));
      endActing = true;
    }
    if (actForRoute) res = await actFor(req, path, body);
    else if (acting && path[0]==='auth') {
      // Account and credential actions stay with the administrator's own account; the act-for session ends on sign-out.
      if (path[1]==='me' && req.method==='GET') res = NextResponse.json({ user: { id: acting.id, email: acting.email, role: acting.role, buyer_id: acting.buyer_id } });
      else { res = await authRequest(req,path[1],body); if (path[1]==='logout') setActForCookie(res, null); }
    }
    else if (acting) res = await onBehalf(req, acting, path, body);
    else if(path[0]==='portal-auth'&&path.length===2)res=await portalAuth(req,path[1],body);
    else if (path[0] === 'auth' && path.length === 2) res = await authRequest(req,path[1],body);
    else if (path.length === 1 && path[0] === 'health' && req.method === 'GET') {
      await rows('SELECT 1');
      res = NextResponse.json({ status:'ok',backend:'nextjs' });
    } else {
      const actor = await authenticate(req);
      await gate(actor, req.method, path);
      const result = await route(actor, req, path, body);
      res = result.status === 204 ? new NextResponse(null,{status:204}) : NextResponse.json(result.data,{status:result.status ?? 200});
    }
    if (endActing) setActForCookie(res, null);
    return secureHeaders(res);
  } catch (error) {
    let status = 500;
    let message = 'Internal server error';
    if (error instanceof ApiError) { status=error.status; message=error.message; }
    else if (error instanceof z.ZodError) { status=422; message=error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '); }
    else if (transient(error)) { status=503; message='The service is busy. Please retry shortly.'; }
    else if (error && typeof error === 'object' && 'code' in error) {
      if (error.code === '23505') { status=409; message='A record with those details already exists'; }
      if (error.code === '23503') { status=409; message='Record has related data or a referenced record does not exist'; }
      if (error.code === '23514' || error.code === '22003' || error.code === '23502') { status=422; message='Invalid field value'; }
    }
    if (status === 500) console.error('API request failed',error);
    const res = secureHeaders(NextResponse.json({error:message,errors:[message]},{status}));
    if (status===429) res.headers.set('Retry-After','900');
    if (status===503) res.headers.set('Retry-After','5');
    return res;
  }
}
