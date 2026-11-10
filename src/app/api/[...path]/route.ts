import { NextRequest } from 'next/server';
import { handleRequest } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ path: string[] }> };
async function handler(req: NextRequest, context: Context) {
  const { path } = await context.params;
  return handleRequest(req,path);
}
export { handler as GET, handler as POST, handler as PATCH, handler as PUT, handler as DELETE };
