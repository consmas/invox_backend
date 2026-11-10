import {NextRequest,NextResponse} from 'next/server';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {authenticate,verifyOrigin} from '@/server/auth';
import {rows} from '@/server/db';
export const runtime='nodejs';
export async function POST(req:NextRequest){
 try{
  verifyOrigin(req);const actor=await authenticate(req);
  if(Number(req.headers.get('content-length')??0)>11*1024*1024)return NextResponse.json({error:'Maximum file size is 10 MB'},{status:413});
  const form=await req.formData();const file=form.get('file');if(!(file instanceof File)||file.size<1||file.size>10*1024*1024)return NextResponse.json({error:'Choose a file up to 10 MB'},{status:422});
  const buffer=Buffer.from(await file.arrayBuffer());const magic=buffer.subarray(0,8);const pdf=buffer.subarray(0,5).toString()==='%PDF-';const png=magic.toString('hex')==='89504e470d0a1a0a';const jpeg=magic[0]===255&&magic[1]===216;
  if(!pdf&&!png&&!jpeg)return NextResponse.json({error:'Upload a PDF, PNG or JPEG document'},{status:422});
  const root=process.env.DOCUMENT_STORAGE_PATH||resolve(process.cwd(),'.local-documents');if(process.env.NODE_ENV==='production'&&!process.env.DOCUMENT_STORAGE_PATH)return NextResponse.json({error:'Persistent private document storage is not configured'},{status:503});
  await mkdir(root,{recursive:true,mode:0o700});const key=randomUUID();await writeFile(resolve(root,key),buffer,{mode:0o600,flag:'wx'});
  const [supplier]=await rows('SELECT id FROM suppliers WHERE user_id=$1',[actor.id]);
  const [doc]=await rows("INSERT INTO documents(buyer_id,supplier_id,category,file_name,mime_type,size_bytes,storage_key,sha256,uploaded_by,upload_status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'stored',$9) RETURNING id,file_name,category,size_bytes,created_at",[actor.buyer_id,supplier?.id??null,String(form.get('category')??'supporting_document').slice(0,100),file.name.replace(/[\x00-\x1f]/g,'').slice(0,200),pdf?'application/pdf':png?'image/png':'image/jpeg',file.size,key,createHash('sha256').update(buffer).digest('hex'),actor.id]);
  return NextResponse.json({id:doc.id,name:doc.file_name,kind:doc.category,sizeKb:Number(doc.size_bytes)/1024,uploadedAt:doc.created_at,uploadedBy:actor.email},{status:201});
 }catch(error){const e=error as {status?:number;message:string};return NextResponse.json({error:e.status?e.message:'Document upload failed'},{status:e.status??500});}
}
