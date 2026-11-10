import {NextRequest,NextResponse} from 'next/server';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {authenticate} from '@/server/auth';
import {rows} from '@/server/db';
import {resourceRequest} from '@/server/resources';
export const runtime='nodejs';
export async function GET(req:NextRequest,{params}:{params:Promise<{id:string}>}){
 try{const actor=await authenticate(req);const {id}=await params;if(!/^\d+$/.test(id))return new NextResponse(null,{status:404});const [doc]=await rows('SELECT * FROM documents WHERE id=$1',[id]);if(!doc)return new NextResponse(null,{status:404});
 let allowed=actor.role==='platform_ops'||String(doc.uploaded_by)===actor.id||actor.role==='buyer_admin'&&String(doc.buyer_id)===actor.buyer_id;
 if(!allowed&&doc.invoice_id){try{await resourceRequest(actor,'GET',['invoices',String(doc.invoice_id)]);allowed=true;}catch{}}
 if(!allowed){const invoices=await rows("SELECT id FROM invoices WHERE supporting_documents @> $1::jsonb",[JSON.stringify([{document_id:String(doc.id)}])]);for(const invoice of invoices){try{await resourceRequest(actor,'GET',['invoices',String(invoice.id)]);allowed=true;break;}catch{}}}
 if(!allowed)return new NextResponse(null,{status:404});
 if(!/^[a-f0-9-]{36}$/.test(doc.storage_key))return new NextResponse(null,{status:404});const bytes=await readFile(resolve(process.env.DOCUMENT_STORAGE_PATH||resolve(process.cwd(),'.local-documents'),doc.storage_key));
 return new NextResponse(bytes,{headers:{'Content-Type':doc.mime_type,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(doc.file_name)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
 }catch{return new NextResponse(null,{status:404});}
}
