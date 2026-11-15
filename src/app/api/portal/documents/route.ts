import {NextRequest,NextResponse} from 'next/server';
import {randomUUID,createHash} from 'node:crypto';
import {authenticate,verifyOrigin,rateLimit,privilegedMfaRequired} from '@/server/auth';
import {rows} from '@/server/db';
import {ApiError} from '@/server/errors';
import {readLimited,secureHeaders} from '@/server/http';
import {withRequest} from '@/server/context';
import {documentStorage} from '@/server/storage';
import {delegatedActor,recordDelegatedAction,emailRecipients} from '@/server/act-for';
import {orgRef} from '@/server/portal-support';
import {transaction} from '@/server/db';
export const runtime='nodejs';

const MAX_FILE=10*1024*1024;
const MAX_BODY=MAX_FILE+256*1024; // multipart boundaries and field headers
const QUOTA=Number(process.env.DOCUMENT_QUOTA_BYTES)||250*1024*1024;
const DAILY_FILES=Number(process.env.DOCUMENT_DAILY_LIMIT)||100;
const CONCURRENT=Math.max(1,Number(process.env.DOCUMENT_UPLOAD_CONCURRENCY)||4);
let active=0;

const MIN_IMAGE_SIDE=Number(process.env.DOCUMENT_MIN_IMAGE_PX)||600;
/** Pixel dimensions from the PNG header or the JPEG start-of-frame marker; null when they cannot be read. */
function imageSize(buffer:Buffer,png:boolean):{width:number;height:number}|null{
 if(png)return buffer.length>=24?{width:buffer.readUInt32BE(16),height:buffer.readUInt32BE(20)}:null;
 let offset=2;
 while(offset+9<buffer.length){
  if(buffer[offset]!==0xff){offset++;continue;}
  const marker=buffer[offset+1];const length=buffer.readUInt16BE(offset+2);
  if(marker>=0xc0&&marker<=0xcf&&![0xc4,0xc8,0xcc].includes(marker))return {height:buffer.readUInt16BE(offset+5),width:buffer.readUInt16BE(offset+7)};
  offset+=2+length;
 }
 return null;
}
function fail(status:number,error:string){return secureHeaders(NextResponse.json({error},{status}));}
export function POST(req:NextRequest){return withRequest(req,()=>upload(req));}
async function upload(req:NextRequest){
 let stored:string|undefined;
 // A bounded number of uploads are buffered at once; excess requests are refused rather than queued in memory (F12).
 if(active>=CONCURRENT)return fail(503,'Uploads are busy. Please retry shortly.');
 active++;
 try{
  verifyOrigin(req);const signedIn=await authenticate(req);
  // A super administrator acting for an organisation uploads into that organisation; the administrator stays the uploader.
  const delegated=await delegatedActor(req,signedIn);const actor=delegated??signedIn;
  if(privilegedMfaRequired(actor))return fail(403,'Operations accounts must enrol and verify an authenticator before using the workspace');
  if(actor.role==='buyer_admin'&&!actor.buyer_id){const [user]=await rows('SELECT portal_registration FROM users WHERE id=$1',[actor.id]);if(!user?.portal_registration)return fail(403,'Your account is not linked to an active organisation');}
  await rateLimit(`upload:${signedIn.id}`,30);
  const bytes=await readLimited(req,MAX_BODY);
  const form=await new Response(Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength) as unknown as BodyInit,{headers:{'content-type':req.headers.get('content-type')??''}}).formData().catch(()=>null);
  const file=form?.get('file');
  if(!(file instanceof File)||file.size<1||file.size>MAX_FILE)return fail(422,'Choose a file up to 10 MB');
  const buffer=Buffer.from(await file.arrayBuffer());const magic=buffer.subarray(0,8);const pdf=buffer.subarray(0,5).toString()==='%PDF-';const png=magic.toString('hex')==='89504e470d0a1a0a';const jpeg=magic[0]===255&&magic[1]===216&&magic[2]===255;
  if(!pdf&&!png&&!jpeg)return fail(422,'Upload a PDF, PNG or JPEG document');
  // S2.2: a photographed document must be readable; refuse it now with corrective advice rather than failing in review later.
  const size=png||jpeg?imageSize(buffer,png):null;
  if(size&&Math.min(size.width,size.height)<MIN_IMAGE_SIDE)return fail(422,`This photo is too small to read (${size.width}×${size.height} pixels). Take it again closer, in good light, with the whole page in view.`);
  const [usage]=await rows("SELECT coalesce(sum(size_bytes),0)::bigint AS bytes,count(*) FILTER (WHERE created_at>now()-interval '1 day')::int AS today FROM documents WHERE (uploaded_by=$1 OR on_behalf_of_user_id=$1) AND archived_at IS NULL",[actor.id]);
  if(Number(usage.bytes)+file.size>QUOTA)return fail(413,'Your document storage allowance is full. Archive unused documents or contact operations.');
  if(Number(usage.today)>=DAILY_FILES)return fail(429,'Daily upload limit reached. Try again tomorrow.');
  const key=randomUUID();const sha256=createHash('sha256').update(buffer).digest('hex');const mime=pdf?'application/pdf':png?'image/png':'image/jpeg';
  await documentStorage().put(key,buffer,mime,sha256);stored=key;
  const [supplier]=await rows('SELECT id FROM suppliers WHERE user_id=$1',[actor.id]);
  // New files start unscanned and unreviewed; only operations review can make them accepted evidence (F12/F17).
  const ref=delegated?.delegation?.target.startsWith('user-')?null:await orgRef(actor);
  const insertDoc=async()=>{const [record]=await rows("INSERT INTO documents(buyer_id,supplier_id,category,file_name,mime_type,size_bytes,storage_key,sha256,uploaded_by,upload_status,scan_status,created_by,org_ref,on_behalf_of_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'stored','pending',$9,$10,$11) RETURNING id,file_name,category,size_bytes,created_at",[actor.buyer_id,supplier?.id??null,String(form!.get('category')??'supporting_document').slice(0,100),file.name.replace(/[\x00-\x1f]/g,'').slice(0,200),mime,file.size,key,sha256,signedIn.id,ref&&ref!=='platform'?ref:null,delegated?actor.id:null]);return record;};
  let notice:{recipients:string[];subject:string;body:string}|null=null;
  const doc=delegated?await transaction(async db=>{const record=await insertDoc();notice=await recordDelegatedAction(actor,'POST',['documents'],{status:201,data:{id:record.id}},db);return record;}):await insertDoc();
  stored=undefined;
  if(notice){const sent=notice as {recipients:string[];subject:string;body:string};await emailRecipients(sent.recipients,sent.subject,sent.body);}
  return secureHeaders(NextResponse.json({id:doc.id,name:doc.file_name,kind:doc.category,sizeKb:Number(doc.size_bytes)/1024,uploadedAt:doc.created_at,uploadedBy:signedIn.email},{status:201}));
 }catch(error){
  if(error instanceof ApiError)return fail(error.status,error.message);
  console.error('Document upload failed',error);return fail(500,'Document upload failed');
 }finally{
  active--;
  // Metadata failed after the object was written: remove it so storage holds no unreferenced files.
  if(stored)await documentStorage().remove(stored).catch(()=>undefined);
 }
}
