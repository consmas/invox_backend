import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticate, verifyOrigin } from './auth';
import { authRequest } from './auth-routes';
import { ApiError } from './errors';
import { resourceRequest } from './resources';
import { rows } from './db';
import { financeRequest } from './finance';
import {portalRequest,sessionData} from './portal';
import {portalAuth} from './portal-auth';
import { definitions,controlRecords,lookup } from './control-records';

export async function handleRequest(req: NextRequest, path: string[]): Promise<NextResponse> {
  try {
    verifyOrigin(req);
    if (path[0] === 'v1') path = path.slice(1);
    let body: Record<string, unknown> = {};
    if (['POST','PATCH','PUT'].includes(req.method)) {
      const text = await req.text();
      if (text.length > 1024*1024) throw new ApiError(413, 'Request body is too large');
      if (text) {
        try { body = z.record(z.string(),z.unknown()).parse(JSON.parse(text)); }
        catch { throw new ApiError(400, 'Expected a JSON object'); }
      }
    }
    let res: NextResponse;
    if(path[0]==='portal-auth'&&path.length===2)res=await portalAuth(req,path[1],body);
    else if (path[0] === 'auth' && path.length === 2) res = await authRequest(req,path[1],body);
    else if (path.length === 1 && path[0] === 'health' && req.method === 'GET') {
      await rows('SELECT 1');
      res = NextResponse.json({ status:'ok',backend:'nextjs' });
    } else {
      const actor = await authenticate(req);
      if(['POST','PATCH','PUT','DELETE'].includes(req.method)&&!(path[0]==='portal'&&['profile','notifications'].includes(path[1]))){const session=await sessionData(actor);if(session.needs_onboarding)throw new ApiError(403,'Complete organisation verification before using transaction actions');}
      if(req.headers.has('idempotency-key'))body.idempotency_key=req.headers.get('idempotency-key');
      const financial=['agreements','fundings','repayments'].includes(path[0])||path[0]==='invoices'&&['financials','agreements','fundings','repayments'].includes(path[2]);
      const result: {status?:number;data?:unknown} = path[0]==='portal'?await portalRequest(actor,req.method,path,body):path[0]==='field-definitions'&&req.method==='GET'?await definitions(actor,path)
        :path[0]==='lookups'&&path.length===2&&req.method==='GET'?await lookup(actor,path[1])
        :path[0]==='controls'?await controlRecords(actor,req.method,path,body)
        :financial?await financeRequest(actor,req.method,path,body):await resourceRequest(actor,req.method,path,body);
      res = result.status === 204 ? new NextResponse(null,{status:204}) : NextResponse.json(result.data,{status:result.status ?? 200});
    }
    res.headers.set('Cache-Control','no-store');
    res.headers.set('X-Content-Type-Options','nosniff');
    return res;
  } catch (error) {
    let status = 500;
    let message = 'Internal server error';
    if (error instanceof ApiError) { status=error.status; message=error.message; }
    else if (error instanceof z.ZodError) { status=422; message=error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '); }
    else if (error && typeof error === 'object' && 'code' in error) {
      if (error.code === '23505') { status=409; message='A record with those details already exists'; }
      if (error.code === '23503') { status=409; message='Record has related data or a referenced record does not exist'; }
      if (error.code === '23514' || error.code === '22003' || error.code === '23502') { status=422; message='Invalid field value'; }
    }
    if (status === 500) console.error('API request failed',error);
    const res = NextResponse.json({error:message,errors:[message]},{status,headers:{'Cache-Control':'no-store'}});
    if (status===429) res.headers.set('Retry-After','900');
    return res;
  }
}
