import {onboardingSchema} from './onboarding-input';
import {createHmac,randomBytes,randomInt,randomUUID,createCipheriv,createDecipheriv,timingSafeEqual} from 'node:crypto';
import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {rows,transaction,insert,type Row} from './db';
import {authenticate,createSession,COOKIE_NAME,SESSION_SECONDS,hashPassword,verifyPassword,digest,rateLimit,newToken,requestToken} from './auth';
import {email,password} from './validation';
import {requireCondition,ApiError} from './errors';
import {sendLink,appUrl} from './mail';
import {orgRef,portalEvent,sessionData} from './portal';
function session(response:NextResponse,token:string,remember=true){response.cookies.set(COOKIE_NAME,token,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',path:'/',maxAge:remember?SESSION_SECONDS:undefined});return response;}
function key(){const k=process.env.MFA_SECRET_KEY;requireCondition(k&&/^[a-f0-9]{64}$/i.test(k),503,'Authenticator encryption is not configured');return Buffer.from(k,'hex');}
function seal(value:Buffer){const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key(),iv);const data=Buffer.concat([cipher.update(value),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');}
function unseal(value:string){const data=Buffer.from(value,'base64');const decipher=createDecipheriv('aes-256-gcm',key(),data.subarray(0,12));decipher.setAuthTag(data.subarray(12,28));return Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]);}
function base32(value:Buffer){let bits='';for(const byte of value)bits+=byte.toString(2).padStart(8,'0');return bits.match(/.{1,5}/g)!.map(chunk=>'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[parseInt(chunk.padEnd(5,'0'),2)]).join('');}
/** Returns the accepted TOTP time step (±1 step of clock skew), or null. Callers refuse steps already consumed. */
function validCode(secret:Buffer,code:string):number|null{const step=Math.floor(Date.now()/30000);for(const delta of [-1,0,1]){const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(step+delta));const hash=createHmac('sha1',secret).update(counter).digest();const offset=hash[19]&15;const expected=String((hash.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');if(timingSafeEqual(Buffer.from(expected),Buffer.from(code)))return step+delta;}return null;}
/** Atomically consumes a code for this authenticator: the same or an earlier time step can never be used twice. */
async function consumeCode(userId:string,secret:string|null,code:string,db:Parameters<typeof rows>[2]){const [user]=await rows('SELECT mfa_last_used_step FROM users WHERE id=$1 FOR UPDATE',[userId],db);const step=secret?validCode(unseal(secret),code):null;if(step===null||(user?.mfa_last_used_step!=null&&step<=Number(user.mfa_last_used_step)))return false;await rows('UPDATE users SET mfa_last_used_step=$2 WHERE id=$1',[userId,step],db);return true;}
export async function challengeFor(user:Row,remember=true){const token=newToken();await rows("INSERT INTO portal_mfa_challenges(token_hash,user_id,expires_at,attempts,user_jti) VALUES($1,$2,now()+interval '5 minutes',0,$3)",[digest(token),user.id,user.jti]);const response=NextResponse.json({mfa_required:true});response.cookies.delete(COOKIE_NAME);response.cookies.set('invox_mfa_remember',remember?'1':'0',{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',path:'/',maxAge:300});response.cookies.set('invox_mfa_challenge',token,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',path:'/',maxAge:300});return response;}
import type {Actor} from './auth';
export async function portalAuth(req:NextRequest,action:string,body:Row,onBehalf?:Actor):Promise<NextResponse>{
 if(action==='contact'&&req.method==='POST'){
  const sender=await (await import('./auth')).actorForToken((await import('./auth')).requestToken(req));
  if(sender){body.email=sender.email;body.name=sender.email;}
  const data=z.object({name:z.string().trim().min(2).max(200),email,company:z.string().max(200).optional(),subject:z.string().max(200).optional(),message:z.string().trim().min(10).max(10000)}).parse(body);await rateLimit(`contact:${data.email}`,5);await rows('INSERT INTO portal_messages(name,email,company,subject,body) VALUES($1,$2,$3,$4,$5)',[data.name,data.email,data.company??null,data.subject??null,data.message]);return NextResponse.json({received:true},{status:201});
 }
 if(action==='register'&&req.method==='POST'){
  const data=z.object({email,password,name:z.string().trim().min(3).max(200)}).parse(body);await rateLimit(`register:${data.email}`,5);
  const result=await transaction(async db=>{const user=await insert('users',{email:data.email,name:data.name,encrypted_password:await hashPassword(data.password),role:0,buyer_id:null,jti:randomUUID(),portal_registration:true},db);return {token:await createSession(user,db)};});return session(NextResponse.json({ok:true},{status:201}),result.token);
 }
 if(action==='mfa-verify'&&req.method==='POST'){
  const code=z.string().regex(/^\d{6}$/).parse(body.code);const token=req.cookies.get('invox_mfa_challenge')?.value;requireCondition(token,401,'Sign in again to request a new challenge');await rateLimit(`mfa:${digest(token)}`,5);
  const result=await transaction(async db=>{
   // The challenge is valid only for the credential epoch it was issued under; password changes and revocations rotate jti.
   const [challenge]=await rows('SELECT c.*,u.mfa_secret_encrypted,u.mfa_enrolled_at,u.jti,u.disabled_at FROM portal_mfa_challenges c JOIN users u ON u.id=c.user_id WHERE c.token_hash=$1 AND c.expires_at>now() FOR UPDATE OF c,u',[digest(token)],db);
   requireCondition(challenge&&challenge.mfa_enrolled_at&&!challenge.disabled_at&&challenge.user_jti===challenge.jti,422,'Invalid or expired authenticator code');
   requireCondition(await consumeCode(String(challenge.user_id),challenge.mfa_secret_encrypted,code,db),422,'Invalid or expired authenticator code');
   await rows('DELETE FROM portal_mfa_challenges WHERE token_hash=$1',[digest(token)],db);
   return createSession({id:challenge.user_id,jti:challenge.jti},db,true);});const response=session(NextResponse.json({ok:true}),result,req.cookies.get('invox_mfa_remember')?.value!=='0');response.cookies.delete('invox_mfa_challenge');response.cookies.delete('invox_mfa_remember');return response;
 }
 // A super administrator completing onboarding for a registrant arrives with the registrant's delegated actor.
 const actor=onBehalf??await authenticate(req);
 if(action==='email-send'&&req.method==='POST'){
  await rateLimit(`email-code:${actor.id}`,5);const code=String(randomInt(100000,1000000));await rows("INSERT INTO portal_email_codes VALUES($1,$2,now()+interval '15 minutes',0) ON CONFLICT(user_id) DO UPDATE SET code_hash=$2,expires_at=now()+interval '15 minutes',attempts=0",[actor.id,digest(code)]);const delivery=await sendLink(actor.email,'Verify your INVOX email',`${appUrl()}/verify-email?code=${code}`);return NextResponse.json(delivery);
 }
 if(action==='email-verify'&&req.method==='POST'){
  const code=z.string().regex(/^\d{6}$/).parse(body.code);await rateLimit(`email-verify:${actor.id}`,5);await transaction(async db=>{const [stored]=await rows('SELECT * FROM portal_email_codes WHERE user_id=$1 AND expires_at>now() FOR UPDATE',[actor.id],db);requireCondition(stored&&stored.code_hash===digest(code),422,'Invalid or expired email code');await rows('UPDATE users SET email_verified_at=now() WHERE id=$1',[actor.id],db);await rows('DELETE FROM portal_email_codes WHERE user_id=$1',[actor.id],db);});return NextResponse.json({verified:true});
 }
 if(action==='mfa-setup'&&req.method==='POST'){
  await rateLimit(`mfa-enrol:${actor.id}`,5);const [user]=await rows('SELECT mfa_enrolled_at,encrypted_password FROM users WHERE id=$1',[actor.id]);requireCondition(typeof body.password==='string'&&await verifyPassword(body.password,user.encrypted_password),403,'Current password is required');requireCondition(!user.mfa_enrolled_at,409,'An authenticator is already enrolled');const secret=randomBytes(20);await rows('UPDATE users SET mfa_secret_encrypted=$2 WHERE id=$1',[actor.id,seal(secret)]);const text=base32(secret);return NextResponse.json({secret:text,uri:`otpauth://totp/INVOX:${encodeURIComponent(actor.email)}?secret=${text}&issuer=INVOX`});
 }
 if(action==='mfa-enrol'&&req.method==='POST'){
  const code=z.string().regex(/^\d{6}$/).parse(body.code);await rateLimit(`mfa-enrol-verify:${actor.id}`,5);
  await transaction(async db=>{const [user]=await rows('SELECT mfa_secret_encrypted,mfa_enrolled_at FROM users WHERE id=$1 FOR UPDATE',[actor.id],db);requireCondition(!user.mfa_enrolled_at,409,'An authenticator is already enrolled');requireCondition(await consumeCode(actor.id,user.mfa_secret_encrypted,code,db),422,'Invalid authenticator code');await rows('UPDATE users SET mfa_enrolled_at=now(),mfa_verified_at=now() WHERE id=$1',[actor.id],db);
   // This browser has now proven possession of the authenticator, which lifts the enrolment-only restriction for operations.
   await rows('UPDATE app_sessions SET mfa_verified_at=now() WHERE token_hash=$1 AND user_id=$2',[digest(requestToken(req)!),actor.id],db);await portalEvent(actor,'mfa.enrolled',null,null,{},db);});return NextResponse.json({enrolled:true});
 }
 if(action==='onboarding'&&req.method==='GET'){
  const ref=await orgRef(actor);const [review]=ref?await rows('SELECT * FROM portal_org_reviews WHERE org_ref=$1',[ref]):[];return NextResponse.json({session:await sessionData(actor),review:review??null});
 }
 if(action==='onboarding'&&req.method==='POST'){
  const data=onboardingSchema.parse(body);
  return transaction(async db=>{const [user]=await rows('SELECT * FROM users WHERE id=$1 FOR UPDATE',[actor.id],db);const old=await orgRef(actor,db);requireCondition((user.portal_registration||old&&old!=='platform')&&(user.email_verified_at||actor.delegation),403,'Verify your registration email first');if(old)requireCondition(data.type.toLowerCase()===old.split('-')[0],422,'Organisation type must match your registered account');const [review]=old?await rows('SELECT * FROM portal_org_reviews WHERE org_ref=$1',[old],db):[];requireCondition(!review||review.status==='INFO_REQUIRED',409,'Your application is already under review');
   requireCondition(new Set(data.document_ids).size>=(data.type==='FINANCIER'?4:3),422,'Upload every required verification document');
   const docs=await rows("SELECT id,sha256,category FROM documents WHERE id=ANY($1::bigint[]) AND (uploaded_by=$2 OR on_behalf_of_user_id=$2 OR org_ref=$3) AND upload_status='stored' AND archived_at IS NULL AND review_status<>'rejected'",[data.document_ids,actor.id,old],db);requireCondition(docs.length===new Set(data.document_ids).size,422,'Upload all required evidence documents');
   const company=data.company;const country=({Ghana:'GH',Nigeria:'NG',Kenya:'KE',"Côte d'Ivoire":'CI',Senegal:'SN',"South Africa":'ZA',"United Kingdom":'GB'} as Record<string,string>)[company.country]??company.country.toUpperCase();requireCondition(/^[A-Z]{2}$/.test(country),422,'Use a supported country or two-letter country code');let ref=old;
   if(!old){const common={name:company.name,registration_number:company.registrationNumber,country,registered_address:company.address,industry:company.industry,contact_phone:company.phone,contact_name:data.representative.fullName,contact_title:data.representative.jobTitle};
    if(data.type==='BUYER'){const buyer=await insert('buyers',{...common,contact_email:company.email},db);await rows('UPDATE users SET buyer_id=$2,role=0 WHERE id=$1',[actor.id,buyer.id],db);ref=`buyer-${buyer.id}`;await rows('UPDATE documents SET buyer_id=$2 WHERE id=ANY($1::bigint[])',[data.document_ids,buyer.id],db);}
    if(data.type==='SUPPLIER'){const supplier=await insert('suppliers',{...common,email:company.email,user_id:actor.id},db);await rows('UPDATE users SET role=1 WHERE id=$1',[actor.id],db);ref=`supplier-${supplier.id}`;await rows('UPDATE documents SET supplier_id=$2 WHERE id=ANY($1::bigint[])',[data.document_ids,supplier.id],db);}
    if(data.type==='FINANCIER'){await rows('INSERT INTO financier_profiles(user_id,name,registration_number,country,registered_address,industry,contact_email,contact_phone,contact_name,contact_title,institution_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[actor.id,company.name,company.registrationNumber,country,company.address,company.industry,company.email,company.phone,data.representative.fullName,data.representative.jobTitle,'pending_classification'],db);await rows('UPDATE users SET role=3 WHERE id=$1',[actor.id],db);ref=`financier-${actor.id}`;}
   }
   await rows('UPDATE documents SET org_ref=$2 WHERE id=ANY($1::bigint[]) AND org_ref IS NULL',[data.document_ids,ref],db);
   await rows('UPDATE users SET name=$2,job_title=$3,contact_phone=$4 WHERE id=$1',[actor.id,data.representative.fullName,data.representative.jobTitle,data.representative.phone],db);
   await rows("INSERT INTO portal_org_reviews(org_ref,payload,submitted_by) VALUES($1,$2,$3) ON CONFLICT(org_ref) DO UPDATE SET status='PENDING_REVIEW',payload=$2,note=NULL,submitted_by=$3,submitted_at=now()",[ref,JSON.stringify({...data,document_evidence:docs.map(doc=>({id:String(doc.id),sha256:doc.sha256,category:doc.category}))}),actor.id],db);await portalEvent(actor,'onboarding.submitted',null,null,{org_ref:ref},db);return NextResponse.json({org_ref:ref,status:'PENDING_REVIEW'});
  });
 }
 throw new ApiError(404,'Authentication action not found');
}
