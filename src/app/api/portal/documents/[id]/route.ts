import {NextRequest,NextResponse} from 'next/server';
import {authenticate,privilegedMfaRequired} from '@/server/auth';
import {rows} from '@/server/db';
import {resourceRequest} from '@/server/resources';
import {secureHeaders} from '@/server/http';
import {documentStorage} from '@/server/storage';
export const runtime='nodejs';
const missing=()=>secureHeaders(new NextResponse(null,{status:404}));
export async function GET(req:NextRequest,{params}:{params:Promise<{id:string}>}){
 try{const actor=await authenticate(req);if(privilegedMfaRequired(actor))return missing();const {id}=await params;if(!/^\d+$/.test(id))return missing();const [doc]=await rows('SELECT * FROM documents WHERE id=$1',[id]);if(!doc||doc.archived_at)return missing();
 let allowed=actor.role==='platform_ops'||String(doc.uploaded_by)===actor.id||actor.role==='buyer_admin'&&!!actor.buyer_id&&String(doc.buyer_id)===actor.buyer_id;
 if(!allowed&&doc.invoice_id){try{await resourceRequest(actor,'GET',['invoices',String(doc.invoice_id)]);allowed=true;}catch{}}
 if(!allowed){const invoices=await rows("SELECT id FROM invoices WHERE supporting_documents @> $1::jsonb",[JSON.stringify([{document_id:String(doc.id)}])]);for(const invoice of invoices){try{await resourceRequest(actor,'GET',['invoices',String(invoice.id)]);allowed=true;break;}catch{}}}
 if(!allowed)return missing();
 // Streamed from shared storage rather than buffered whole in memory (F12/F13).
 const body=await documentStorage().stream(doc.storage_key);
 const res=new NextResponse(body,{headers:{'Content-Type':doc.mime_type,'Content-Length':String(doc.size_bytes),'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(doc.file_name)}`}});
 secureHeaders(res);res.headers.set('Cache-Control','private, no-store');return res;
 }catch{return missing();}
}
