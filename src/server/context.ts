import { AsyncLocalStorage } from 'node:async_hooks';
import { isIP } from 'node:net';
import type { NextRequest } from 'next/server';
import { ApiError } from './errors';

type RequestContext = { expectedUpdatedAt?: string; clientIp: string };
const store = (globalThis as unknown as { invoixRequest?: AsyncLocalStorage<RequestContext> });
const requests = store.invoixRequest ??= new AsyncLocalStorage<RequestContext>();

/**
 * The client address comes only from a header named by CLIENT_IP_HEADER (for example `do-connecting-ip`
 * on DigitalOcean App Platform, or `x-real-ip` behind a proxy you control). Without that setting every
 * caller shares one bucket, which is safe but coarse. Caller-supplied X-Forwarded-For is never trusted.
 */
export function clientIp(req: NextRequest): string {
  const header = process.env.CLIENT_IP_HEADER?.trim().toLowerCase();
  if (!header) return 'unconfigured';
  const raw = req.headers.get(header)?.split(',').map(value => value.trim()).filter(Boolean).at(-1) ?? '';
  return isIP(raw) ? raw : 'unknown';
}
export function withRequest<T>(req: NextRequest, work: () => Promise<T>): Promise<T> {
  const expected = req.headers.get('x-expected-updated-at') ?? undefined;
  return requests.run({ expectedUpdatedAt: expected, clientIp: clientIp(req) }, work);
}
export function currentRequest(): RequestContext | undefined { return requests.getStore(); }

/**
 * Optimistic concurrency: when the client states which version it edited (X-Expected-Updated-At),
 * a record changed since then is rejected instead of being silently overwritten.
 * Callers invoke this after locking the row, so check and write are atomic.
 */
export function assertFresh(record: { updated_at?: unknown } | undefined | null) {
  const expected = requests.getStore()?.expectedUpdatedAt;
  if (!expected || !record || record.updated_at == null) return;
  const wanted = Date.parse(expected);
  if (Number.isNaN(wanted)) throw new ApiError(422, 'X-Expected-Updated-At must be an ISO timestamp');
  const actual = new Date(record.updated_at as string | Date).getTime();
  if (Math.floor(actual) !== Math.floor(wanted)) throw new ApiError(409, 'This record was changed by someone else. Reload it to see the latest version before saving.');
}
