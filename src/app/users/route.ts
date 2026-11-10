import { NextRequest } from 'next/server';
import { handleRequest } from '@/server/http';
// Compatibility with POST /users (Devise registration) on the backend origin.
export const runtime='nodejs';
export function POST(req:NextRequest){return handleRequest(req,['auth','signup']);}
