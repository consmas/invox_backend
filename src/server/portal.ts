import {managementRequest,validateInvoiceSubmission} from './workflow-management';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {type Actor,requireRole} from './auth';
import {rows,transaction,insert,type DB,type Row} from './db';
import {requireCondition,ApiError} from './errors';
import {id,date,email,money} from './validation';
import {coreSchema,databaseValues} from './fields';
import {priceBid,resourceRequest} from './resources';
import {cents} from './money';
import {digest,newToken} from './auth';
import {sendLink,appUrl} from './mail';
import {orgRef,portalEvent,notify,sessionData} from './portal-support';
export {orgRef,portalEvent,sessionData} from './portal-support';
const same=(a:unknown,b:unknown)=>String(a)===String(b);
// Field policy (F09): counterparties receive only the identity and terms needed to act; private legal, fee,
// control and contact configuration stays with the owning organisation and operations.
const programmePublic='p.id,p.name,p.buyer_id,p.currency,p.status,p.programme_reference,p.maximum_tenor_days,p.maturity_days,p.day_count_basis,p.archived_at,p.created_at';
const buyerPublic='b.id,b.name,b.legal_name,b.trading_name,b.country,b.created_at';
const supplierPublic='s.id,s.name,s.legal_name,s.country,s.created_at';
const supplierOwned='s.id,s.name,s.email,s.user_id,s.legal_name,s.registration_number,s.country,s.registered_address,s.industry,s.contact_name,s.contact_phone,s.verification_status,s.created_at';
async function bootstrap(actor:Actor){
 const session=await sessionData(actor);
 const notifications=await rows('SELECT id,subject,body,created_at,read_at,related_id FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 250',[actor.id]);
 // Unverified or membership-less accounts see only their own onboarding material.
 if(actor.role!=='platform_ops'&&(session.needs_onboarding||actor.role==='buyer_admin'&&!actor.buyer_id)){
  const documents=await rows('SELECT id,buyer_id,supplier_id,invoice_id,file_name,category,size_bytes,created_at,uploaded_by,review_status,review_reason FROM documents WHERE archived_at IS NULL AND uploaded_by=$1',[actor.id]);
  const reviews=session.org_ref?await rows('SELECT org_ref,status,note,submitted_at,reviewed_at FROM portal_org_reviews WHERE org_ref=$1',[session.org_ref]):[];
  return {session,invoices:[],programmes:[],buyers:[],suppliers:[],financiers:[],bids:[],tenders:[],tenderInvitations:[],fundings:[],positions:[],agreements:[],events:[],reviews,documents,notifications,exceptions:[],membership:[],mandates:[]};
 }
 const ops=actor.role==='platform_ops';const buyer=actor.role==='buyer_admin';
 const invoices=(await resourceRequest(actor,'GET',['invoices'])).data as Row[];
 const ids=invoices.map(i=>i.id);
 const programmes=ops?await rows('SELECT * FROM programmes'):buyer?await rows('SELECT * FROM programmes WHERE buyer_id=$1',[actor.buyer_id]):await rows(`SELECT ${programmePublic} FROM programmes p WHERE p.id=ANY($1::bigint[])`,[invoices.map(i=>i.programme_id)]);
 const buyers=ops?await rows('SELECT b.*,(SELECT count(*)::int FROM users u WHERE u.buyer_id=b.id) AS user_count FROM buyers b'):[
  ...(buyer?await rows('SELECT b.*,(SELECT count(*)::int FROM users u WHERE u.buyer_id=b.id) AS user_count FROM buyers b WHERE b.id=$1',[actor.buyer_id]):[]),
  ...await rows(`SELECT ${buyerPublic} FROM buyers b WHERE b.id=ANY($1::bigint[]) AND b.id IS DISTINCT FROM $2::bigint`,[invoices.map(i=>i.buyer_id),actor.buyer_id])];
 const suppliers=ops?await rows(`SELECT ${supplierOwned} FROM suppliers s`)
  :buyer?await rows(`SELECT ${supplierOwned} FROM suppliers s WHERE s.id=ANY($1::bigint[]) OR EXISTS(SELECT 1 FROM portal_supplier_relationships r WHERE r.supplier_id=s.id AND r.buyer_id=$2 AND r.status='active')`,[invoices.map(i=>i.supplier_id),actor.buyer_id])
  :actor.role==='supplier_user'?await rows(`SELECT ${supplierOwned} FROM suppliers s WHERE s.user_id=$1`,[actor.id])
  :await rows(`SELECT ${supplierPublic} FROM suppliers s WHERE s.id=ANY($1::bigint[])`,[invoices.map(i=>i.supplier_id)]);
 if(buyer){const relationships=await rows('SELECT * FROM portal_supplier_relationships WHERE buyer_id=$1',[actor.buyer_id]);for(const supplier of suppliers){const relationship=relationships.find(r=>same(r.supplier_id,supplier.id));if(relationship)Object.assign(supplier,{contact_name:relationship.contact_name??supplier.contact_name,contact_phone:relationship.contact_phone??supplier.contact_phone,contact_email:relationship.contact_email??supplier.email});}}
 const bids=await rows(`SELECT d.* FROM bids d WHERE invoice_id=ANY($1::bigint[]) ${actor.role==='financer'?'AND financer_id=$2':''} ${actor.role!=='financer'?"AND portal_state IS DISTINCT FROM 'DRAFT'":''}`,[ids,...(actor.role==='financer'?[actor.id]:[])]);
 const financiers=ops?await rows('SELECT f.*,u.email FROM financier_profiles f JOIN users u ON u.id=f.user_id')
  :await rows(`SELECT f.user_id,f.name,f.country,CASE WHEN f.user_id=$1 THEN f.contact_email END AS email,f.created_at FROM financier_profiles f JOIN users u ON u.id=f.user_id WHERE f.user_id=$1 OR f.user_id=ANY($2::bigint[]) OR ($3 AND u.disabled_at IS NULL AND f.archived_at IS NULL)`,[actor.id,bids.map(b=>b.financer_id),buyer&&!!actor.buyer_id]);
 const tenders=await rows('SELECT * FROM financing_tenders WHERE invoice_id=ANY($1::bigint[]) ORDER BY id',[ids]);
 const tenderInvitations=await rows('SELECT * FROM portal_tender_invitations WHERE tender_id=ANY($1::bigint[]) AND ($2::bigint IS NULL OR financer_id=$2)',[tenders.map(t=>t.id),actor.role==='financer'?actor.id:null]);
 const fundings=await rows(`SELECT f.*,a.bid_id,a.net_disbursement,a.repayment_amount,a.maturity_date FROM fundings f JOIN financing_agreements a ON a.id=f.agreement_id WHERE f.invoice_id=ANY($1::bigint[]) ${actor.role==='financer'?'AND a.bid_id=ANY($2::bigint[])':''}`,[ids,...(actor.role==='financer'?[bids.map(b=>b.id)]:[])]);
 const positions=await rows('SELECT * FROM financial_positions WHERE invoice_id=ANY($1::bigint[])',[fundings.map(f=>f.invoice_id)]);
 const agreements=await rows('SELECT * FROM financing_agreements WHERE invoice_id=ANY($1::bigint[])',[fundings.map(f=>f.invoice_id)]);
 // Audit details and actor e-mail addresses stay with operations; counterparties see what happened and when.
 const events=await rows(`SELECT e.id,e.invoice_id,e.event,e.reason,e.created_at,u.name AS actor_name,CASE WHEN $4 OR e.actor_id=$5 THEN u.email END AS actor_email,u.role AS actor_role,e.org_ref,CASE WHEN $4 THEN e.details ELSE '{}'::jsonb END AS details FROM portal_events e LEFT JOIN users u ON u.id=e.actor_id WHERE ($1 OR e.invoice_id=ANY($2::bigint[])) ${actor.role==='financer'?"AND (e.actor_id=$3 OR e.event NOT LIKE 'bid.%')":'AND $3::bigint IS NOT NULL'} ORDER BY e.id DESC LIMIT 1000`,[ops,ids,actor.id,ops,actor.id]);
 const financialEvents=await rows(`SELECT 'finance-'||e.id::text AS id,e.invoice_id,e.event,NULL::text AS reason,e.created_at,u.name AS actor_name,CASE WHEN $2 OR e.actor_id=$3 THEN u.email END AS actor_email,u.role AS actor_role,NULL::varchar AS org_ref,CASE WHEN $2 THEN e.details ELSE '{}'::jsonb END AS details FROM audit_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.invoice_id=ANY($1::bigint[]) ORDER BY e.id DESC LIMIT 1000`,[actor.role==='financer'?invoices.filter(i=>bids.some(b=>same(b.invoice_id,i.id)&&b.status===1)).map(i=>i.id):ids,ops,actor.id]);
 events.push(...financialEvents);events.sort((a,b)=>new Date(b.created_at).getTime()-new Date(a.created_at).getTime());
 const reviews=await rows('SELECT org_ref,status,CASE WHEN $1 OR org_ref=$3 THEN note ELSE NULL END AS note,submitted_at,reviewed_at FROM portal_org_reviews WHERE $1 OR org_ref=ANY($2::varchar[])',[ops,[...buyers.map(b=>`buyer-${b.id}`),...suppliers.map(s=>`supplier-${s.id}`),...financiers.map(f=>`financier-${f.user_id}`)],session.org_ref]);
 const documents=await rows(`SELECT id,buyer_id,supplier_id,invoice_id,file_name,category,size_bytes,created_at,uploaded_by,review_status,review_reason FROM documents WHERE archived_at IS NULL AND ($1 OR invoice_id=ANY($2::bigint[]) OR uploaded_by=$3 OR buyer_id=$4 OR EXISTS(SELECT 1 FROM invoices i,jsonb_array_elements(coalesce(i.supporting_documents,'[]'::jsonb)) d WHERE i.id=ANY($2::bigint[]) AND d->>'document_id'=documents.id::text))`,[ops,ids,actor.id,buyer?actor.buyer_id:null]);
 const exceptions=ops?await rows('SELECT * FROM portal_exceptions ORDER BY id DESC LIMIT 250'):[];
 // Programme membership is disclosed to the owner; counterparties see only their own participation.
 const membership=ops||buyer?await rows('SELECT * FROM portal_programme_suppliers WHERE programme_id=ANY($1::bigint[])',[programmes.map(p=>p.id)])
  :actor.role==='supplier_user'?await rows('SELECT ps.* FROM portal_programme_suppliers ps JOIN suppliers s ON s.id=ps.supplier_id WHERE ps.programme_id=ANY($1::bigint[]) AND s.user_id=$2',[programmes.map(p=>p.id),actor.id]):[];
 const mandates=ops||buyer?await rows('SELECT * FROM portal_programme_financiers WHERE programme_id=ANY($1::bigint[])',[programmes.map(p=>p.id)])
  :actor.role==='financer'?await rows('SELECT * FROM portal_programme_financiers WHERE programme_id=ANY($1::bigint[]) AND financer_id=$2',[programmes.map(p=>p.id),actor.id]):[];
 return {session,invoices,programmes,buyers,suppliers,financiers,bids,tenders,tenderInvitations,fundings,positions,agreements,events,reviews,documents,notifications,exceptions,membership,mandates};
}
async function ownedInvoice(actor:Actor,invoiceId:string,db:DB){
 const [invoice]=await rows('SELECT i.*,p.buyer_id,p.status AS programme_status,p.currency AS programme_currency,p.archived_at AS programme_archived_at,p.maximum_tenor_days,s.archived_at AS supplier_archived_at,s.user_id AS supplier_user_id FROM invoices i JOIN programmes p ON p.id=i.programme_id JOIN suppliers s ON s.id=i.supplier_id WHERE i.id=$1 FOR UPDATE OF i',[invoiceId],db);
 requireCondition(invoice&&!invoice.deleted_at,404,'Invoice not found');
 requireCondition(actor.role==='platform_ops'||actor.role==='buyer_admin'&&same(actor.buyer_id,invoice.buyer_id)||actor.role==='supplier_user'&&same(actor.id,invoice.supplier_user_id),403,'Invoice is outside your organisation');return invoice;
}
export async function portalRequest(actor:Actor,method:string,path:string[],body:Row):Promise<{data?:unknown;status?:number}>{
 const [,resource,rawId,action]=path;
 if(resource==='manage'||resource==='modules')return managementRequest(actor,method,path,body);
 if(method==='GET'&&resource==='session')return {data:await sessionData(actor)};
 if(method==='GET'&&resource==='bootstrap')return {data:await bootstrap(actor)};
 if(resource==='profile'&&method==='PATCH'){
  const data=z.object({name:z.string().trim().min(2).max(200),job_title:z.string().max(200).optional(),contact_phone:z.string().max(100).optional(),preferences:z.record(z.string(),z.boolean()).optional()}).parse(body);
  await transaction(async db=>{await rows('UPDATE users SET name=$2,job_title=coalesce($3,job_title),contact_phone=coalesce($4,contact_phone),notification_preferences=coalesce($5,notification_preferences),updated_at=now() WHERE id=$1',[actor.id,data.name,data.job_title,data.contact_phone,data.preferences?JSON.stringify(data.preferences):null],db);
  await portalEvent(actor,'profile.updated',null,null,{},db);});return {data:await sessionData(actor)};
 }
 if(resource==='notifications'&&method==='POST'){
  const data=z.object({id:id.optional()}).parse(body);await rows('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND ($2::bigint IS NULL OR id=$2)',[actor.id,data.id??null]);return {data:{ok:true}};
 }
 if(resource==='invoices'&&rawId&&method==='POST')return transaction(async db=>{
  const invoice=await ownedInvoice(actor,id.parse(rawId),db);
  requireCondition(!invoice.financial_review_required&&['draft','approved'].includes(invoice.status),409,'Invoice terms are locked');
  if(action==='submit'){
   requireRole(actor,'buyer_admin','platform_ops');await validateInvoiceSubmission(actor,invoice,db);requireCondition(!['pending','approved'].includes(invoice.invoice_approval_status),409,'Invoice has already been submitted');
   await rows("UPDATE invoices SET status='draft',invoice_approval_status='pending',submitted_for_approval_at=now(),rejection_reason=NULL,clarification_request=NULL,updated_at=now() WHERE id=$1",[invoice.id],db);
   await notify(invoice.supplier_user_id,'Invoice awaiting approval',`Invoice ${invoice.invoice_number} needs your review.`,invoice.id,actor,db);
  }else{
   requireRole(actor,'supplier_user');requireCondition(invoice.invoice_approval_status==='pending',409,'Invoice is not awaiting your decision');
   const input=z.object({decision:z.enum(['approve','reject','clarify']),reason:z.string().trim().min(5).max(2000).optional()}).parse(body);requireCondition(input.decision==='approve'||input.reason,422,'A reason is required');
   await rows("UPDATE invoices SET invoice_approval_status=$2::varchar,status=CASE WHEN $2::varchar='approved' THEN 'approved' ELSE 'draft' END,supplier_approved_at=CASE WHEN $2::varchar='approved' THEN now() ELSE NULL END,supplier_approved_by=CASE WHEN $2::varchar='approved' THEN $3::bigint ELSE NULL END,rejection_reason=CASE WHEN $2::varchar='rejected' THEN $4 ELSE NULL END,clarification_request=CASE WHEN $2::varchar='clarification' THEN $4 ELSE NULL END,updated_at=now() WHERE id=$1",[invoice.id,{approve:'approved',reject:'rejected',clarify:'clarification'}[input.decision],actor.id,input.reason??null],db);
   body.reason=input.reason;const owners=await rows('SELECT id FROM users WHERE buyer_id=$1',[invoice.buyer_id],db);for(const owner of owners)await notify(owner.id,{approve:'Invoice approved by supplier',reject:'Invoice rejected by supplier',clarify:'Supplier asked for clarification'}[input.decision],`${invoice.invoice_number}: ${{approve:'approved and ready to open for financing.',reject:'rejected',clarify:'clarification requested'}[input.decision]}${input.reason?` — ${input.reason}`:input.decision==='approve'?'':'.'}`,invoice.id,actor,db);
  }
  await portalEvent(actor,`invoice.${action==='submit'?'submitted':body.decision}`,body.reason??null,invoice.id,{},db);return {data:{id:invoice.id}};
 });
 if(resource==='tenders'&&method==='POST')return transaction(async db=>{
  requireRole(actor,'buyer_admin','platform_ops');
  const data=z.object({invoice_id:id,requested_amount:money,closes_on:date,financier_ids:z.array(id).min(1).max(100),notes:z.string().max(4000).optional()}).parse(body);
  const invoice=await ownedInvoice(actor,data.invoice_id,db);
  requireCondition(invoice.programme_status==='active'&&!invoice.programme_archived_at,409,'Activate the programme before opening a tender');
  requireCondition(invoice.invoice_approval_status==='approved'&&invoice.status==='approved',409,'Supplier approval is required before opening a tender');
  requireCondition(invoice.financing_eligible&&cents(data.requested_amount)<=cents(invoice.amount),422,'Invalid financing request');
  requireCondition(data.closes_on>=new Date().toISOString().slice(0,10)&&data.closes_on<=invoice.due_date,422,'Tender must close before invoice maturity');
  for(const financer of data.financier_ids){requireCondition((await rows('SELECT 1 FROM portal_programme_financiers WHERE programme_id=$1 AND financer_id=$2',[invoice.programme_id,financer],db)).length,422,'Add the financier to the programme before inviting it');requireCondition((await rows("SELECT f.user_id FROM financier_profiles f JOIN users u ON u.id=f.user_id WHERE f.user_id=$1 AND u.role=3 AND u.disabled_at IS NULL AND f.archived_at IS NULL AND (NOT u.portal_registration OR EXISTS(SELECT 1 FROM portal_org_reviews r WHERE r.org_ref='financier-'||u.id::text AND r.status='APPROVED'))",[financer],db)).length,422,'Financier does not exist');}
  const [tender]=await rows("INSERT INTO financing_tenders(invoice_id,programme_id,tender_reference,currency,financing_amount_requested,opens_at,closes_at,maturity_date,eligible_conditions,risk_disclosures,published_by,published_at,status,created_by) VALUES($1,$2,$3,$4,$5,now(),$6,$7,$8,$9,$10,now(),'open',$10) RETURNING *",[invoice.id,invoice.programme_id,`TND-${randomUUID().slice(0,8).toUpperCase()}`,invoice.currency,data.requested_amount,`${data.closes_on}T23:59:59Z`,invoice.due_date,data.notes??'Invited financiers only',invoice.risk_disclosures??'Subject to executed agreements and independent financial evidence verification.',actor.id],db);
  for(const financer of data.financier_ids){await rows('INSERT INTO portal_tender_invitations VALUES($1,$2)',[tender.id,financer],db);await notify(financer,'Financing opportunity',`A tender for invoice ${invoice.invoice_number} is open.`,invoice.id,actor,db);}
  await rows("UPDATE financing_requests SET status='in_tender',tender_id=$2,updated_at=now() WHERE invoice_id=$1 AND status IN ('submitted','reviewed')",[invoice.id,tender.id],db);
  await rows("UPDATE invoices SET status='tender',financing_amount_requested=$2,updated_at=now() WHERE id=$1",[invoice.id,data.requested_amount],db);
  await portalEvent(actor,'tender.opened',null,invoice.id,{tender_id:tender.id},db);return {data:tender,status:201};
 });
 if(resource==='bids'&&method==='POST'&&!rawId)return transaction(async db=>{
  requireRole(actor,'financer');const data=z.object({tender_id:id,submit:z.boolean(),disbursement_date:date.optional(),bid:z.record(z.string(),z.unknown())}).parse(body);
  const [target]=await rows('SELECT invoice_id FROM financing_tenders WHERE id=$1',[data.tender_id],db);requireCondition(target,404,'Tender not found');
  requireCondition((await rows('SELECT 1 FROM portal_tender_invitations WHERE tender_id=$1 AND financer_id=$2',[data.tender_id,actor.id],db)).length,403,'You are not invited to this tender');
  const [invoice]=await rows('SELECT * FROM invoices WHERE id=$1 FOR UPDATE',[target.invoice_id],db);requireCondition(invoice&&!invoice.deleted_at&&!invoice.financial_review_required,409,'Invoice requires reconciliation');
  const [tender]=await rows('SELECT * FROM financing_tenders WHERE id=$1 FOR UPDATE',[data.tender_id],db);requireCondition(tender&&tender.status==='open'&&new Date(tender.closes_at).getTime()>Date.now(),409,'Tender is closed');
  requireCondition(!data.disbursement_date||(data.disbursement_date>=new Date().toISOString().slice(0,10)&&data.disbursement_date<=invoice.due_date),422,'Disbursement date must be between today and maturity');
  const bidInput=coreSchema('bids').parse(data.bid);const priced=priceBid(bidInput,invoice);requireCondition(cents(String(priced.amount))<=cents(invoice.amount),422,'Offer exceeds invoice face value');const values={...databaseValues('bids',priced),invoice_id:invoice.id,financer_id:actor.id,status:0,portal_state:data.submit?'SUBMITTED':'DRAFT',proposed_disbursement_date:data.disbursement_date??null};
  const [existing]=await rows('SELECT * FROM bids WHERE invoice_id=$1 AND financer_id=$2 AND status=0 FOR UPDATE',[invoice.id,actor.id],db);
  const keys=Object.keys(values);let bid;if(existing){const [updated]=await rows(`UPDATE bids SET ${keys.map((key,i)=>'"'+key+'"=$'+(i+2)).join(',')},updated_at=now() WHERE id=$1 RETURNING *`,[existing.id,...Object.values(values)],db);bid=updated;}else bid=await insert('bids',values,db);
  await portalEvent(actor,data.submit?'bid.submitted':'bid.draft_saved',null,invoice.id,{bid_id:bid.id},db);return {data:bid,status:201};
 });
 if(resource==='bids'&&rawId&&action==='withdraw'&&method==='POST'){
  requireRole(actor,'financer');return transaction(async db=>{const [bid]=await rows("UPDATE bids SET status=2,portal_state='WITHDRAWN',updated_at=now() WHERE id=$1 AND financer_id=$2 AND status=0 RETURNING *",[id.parse(rawId),actor.id],db);requireCondition(bid,409,'This offer cannot be withdrawn');await portalEvent(actor,'bid.withdrawn',null,bid.invoice_id,{bid_id:bid.id},db);return {data:bid};});
 }
 if(resource==='programmes'&&method==='POST'){
  requireRole(actor,'buyer_admin','platform_ops');
  const data=z.object({name:z.string().min(2),currency:z.enum(['GHS','USD','EUR','NGN','KES']),limit:money,max_tenor_days:z.number().int().min(1).max(3650),supplier_ids:z.array(id),financier_ids:z.array(id)}).parse(body);
  requireCondition(actor.buyer_id,422,'Create programmes from the buyer organisation workspace');
  return transaction(async db=>{
   for(const supplier of data.supplier_ids)requireCondition((await rows("SELECT 1 FROM portal_supplier_relationships r JOIN suppliers s ON s.id=r.supplier_id WHERE r.buyer_id=$1 AND r.supplier_id=$2 AND r.status='active' AND s.archived_at IS NULL",[actor.buyer_id,supplier],db)).length,403,'Invite this supplier before adding it to a programme');
   for(const financer of data.financier_ids)requireCondition((await rows('SELECT 1 FROM users u JOIN financier_profiles f ON f.user_id=u.id WHERE u.id=$1 AND u.role=3 AND u.disabled_at IS NULL AND f.archived_at IS NULL',[financer],db)).length,422,'Financier is missing or archived');
   const [programme]=await rows("INSERT INTO programmes(buyer_id,name,\"limit\",fee_percent,maturity_days,programme_reference,currency,maximum_tenor_days,day_count_basis,status) VALUES($1,$2,$3,0,$4,$5,$6,$4,'365','draft') RETURNING *",[actor.buyer_id,data.name,data.limit,data.max_tenor_days,`PRG-${randomUUID().slice(0,8)}`,data.currency],db);
   for(const supplier of data.supplier_ids)await rows('INSERT INTO portal_programme_suppliers VALUES($1,$2)',[programme.id,supplier],db);
   for(const financer of data.financier_ids)await rows('INSERT INTO portal_programme_financiers VALUES($1,$2)',[programme.id,financer],db);
   await portalEvent(actor,'programme.created',null,null,{programme_id:programme.id},db);return {data:programme,status:201};
  });
 }
 if(resource==='suppliers'&&method==='POST'){
  requireRole(actor,'buyer_admin','platform_ops');
  const data=z.object({name:z.string().min(2),email,country:z.string().length(2).default('GH'),contact:z.string().max(200).optional(),programme_id:id}).parse(body);
  return transaction(async db=>{
   const [programme]=await rows('SELECT * FROM programmes WHERE id=$1',[data.programme_id],db);requireCondition(programme&&(actor.role==='platform_ops'||same(programme.buyer_id,actor.buyer_id)),403,'Programme is outside your organisation');requireCondition(!programme.archived_at,409,'Programme is archived');
   let [supplier]=await rows('SELECT * FROM suppliers WHERE lower(email)=$1',[data.email],db);
   let delivery:Row={};
   if(!supplier){
    const token=newToken();const user=await insert('users',{email:data.email,role:1,jti:randomUUID(),encrypted_password:'!invitation-pending',portal_registration:true},db);
    supplier=await insert('suppliers',{name:data.name,email:data.email,country:data.country,user_id:user.id,invitation_token:digest(token),invited_at:new Date(),invitation_expires_at:new Date(Date.now()+7*86400000)},db);
    delivery=await sendLink(data.email,'Your INVOX supplier invitation',`${appUrl()}/invite?token=${token}`);
   }
   await rows('INSERT INTO portal_programme_suppliers VALUES($1,$2) ON CONFLICT DO NOTHING',[programme.id,supplier.id],db);await rows('INSERT INTO portal_supplier_relationships(buyer_id,supplier_id,contact_name,contact_email,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(buyer_id,supplier_id) DO UPDATE SET contact_name=coalesce(EXCLUDED.contact_name,portal_supplier_relationships.contact_name),contact_email=EXCLUDED.contact_email,updated_at=now()',[programme.buyer_id,supplier.id,data.contact??null,data.email,actor.id],db);await portalEvent(actor,'supplier.invited',null,null,{supplier_id:supplier.id},db);return {data:{id:supplier.id,...delivery},status:201};
  });
 }
 if(resource==='verification'&&rawId&&method==='POST'){
  requireRole(actor,'platform_ops');const data=z.object({status:z.enum(['APPROVED','REJECTED','INFO_REQUIRED']),note:z.string().trim().max(4000).optional()}).parse(body);requireCondition(data.status==='APPROVED'||data.note&&data.note.length>=5,422,'A reason is required');
  return transaction(async db=>{const [review]=await rows('SELECT * FROM portal_org_reviews WHERE org_ref=$1 FOR UPDATE',[rawId],db);requireCondition(review,409,'This organisation has not submitted its onboarding evidence');requireCondition(!same(review.submitted_by,actor.id),403,'A different operator must review the submission');
   if(data.status==='APPROVED'){
    // Approval releases the organisation only on the exact submitted evidence: unchanged, current, still owned and verified.
    const submitted=(review.payload?.document_evidence??(review.payload?.document_ids??[]).map((key:string)=>({id:key}))) as {id:string;sha256?:string}[];
    requireCondition(submitted.length>0,409,'Document evidence is required before approval');
    const docs=await rows("SELECT id,sha256,review_status,archived_at FROM documents WHERE id=ANY($1::bigint[]) AND uploaded_by=$2 AND upload_status='stored'",[submitted.map(d=>d.id),review.submitted_by],db);
    for(const item of submitted){const doc=docs.find(d=>same(d.id,item.id));
     requireCondition(doc&&!doc.archived_at&&(!item.sha256||doc.sha256===item.sha256),409,'Submitted evidence has been removed or replaced; request updated information');
     requireCondition(doc.review_status==='verified',409,'Verify every submitted document before approving the organisation');}
   }
   await rows('UPDATE portal_org_reviews SET status=$2,note=$3,reviewed_by=$4,reviewed_at=now() WHERE org_ref=$1',[rawId,data.status,data.note??null,actor.id],db);const [kind,profileId]=rawId.split('-');const table=({buyer:'buyers',supplier:'suppliers',financier:'financier_profiles'} as Record<string,string>)[kind];requireCondition(table&&/^[1-9]\d*$/.test(profileId),422,'Invalid organisation reference');await rows(`UPDATE ${table} SET verification_status=$2,approval_status=$3::varchar,last_verified_at=CASE WHEN $3::varchar='approved' THEN now() ELSE NULL END WHERE ${kind==='financier'?'user_id':'id'}=$1`,[profileId,data.status==='APPROVED'?'verified':data.status==='REJECTED'?'rejected':'pending',data.status.toLowerCase()],db);await portalEvent(actor,'organization.reviewed',data.note??null,null,{org_ref:rawId,status:data.status},db);await notify(review.submitted_by,'Organisation review updated',data.note??`Your application is ${data.status.toLowerCase()}.`,null,actor,db);return {data:{ok:true}};});
 }
 if(resource==='document-reviews'&&rawId&&method==='POST'){
  requireRole(actor,'platform_ops');
  const data=z.object({decision:z.enum(['verify','reject']),reason:z.string().trim().max(2000).optional()}).parse(body);
  requireCondition(data.decision==='verify'||(data.reason?.length??0)>=10,422,'A rejection reason of at least 10 characters is required');
  return transaction(async db=>{
   const [doc]=await rows('SELECT id,uploaded_by,file_name,invoice_id,review_status,archived_at FROM documents WHERE id=$1 FOR UPDATE',[id.parse(rawId)],db);
   requireCondition(doc&&!doc.archived_at,404,'Document not found');
   requireCondition(doc.review_status==='pending',409,'This document has already been reviewed');
   requireCondition(!same(doc.uploaded_by,actor.id),403,'A different operator must review evidence you uploaded');
   const verified=data.decision==='verify';
   const [record]=await rows('UPDATE documents SET review_status=$2,review_reason=$3,verified_by=$4,verified_at=CASE WHEN $5 THEN now() ELSE NULL END,updated_at=now() WHERE id=$1 RETURNING id,file_name,review_status,review_reason,verified_at',[doc.id,verified?'verified':'rejected',data.reason??null,actor.id,verified],db);
   await portalEvent(actor,`document.${verified?'verified':'rejected'}`,data.reason??null,doc.invoice_id?String(doc.invoice_id):null,{document_id:doc.id},db);
   if(doc.uploaded_by)await notify(String(doc.uploaded_by),verified?'Document verified':'Document rejected',verified?`${doc.file_name} was verified.`:`${doc.file_name} was rejected: ${data.reason}`,doc.invoice_id?String(doc.invoice_id):null,actor,db);
   return {data:record};
  });
 }
 if(resource==='organization-users'&&rawId&&method==='GET'){
  requireCondition(actor.role==='platform_ops'||rawId===await orgRef(actor),403,'Organisation is outside your scope');const [type,key]=rawId.split('-');const users=type==='buyer'?await rows('SELECT id,name,email,role,job_title,last_successful_login_at FROM users WHERE buyer_id=$1',[id.parse(key)]):type==='supplier'?await rows('SELECT u.id,u.name,u.email,u.role,u.job_title,u.last_successful_login_at FROM users u JOIN suppliers s ON s.user_id=u.id WHERE s.id=$1',[id.parse(key)]):await rows('SELECT id,name,email,role,job_title,last_successful_login_at FROM users WHERE id=$1 AND role=3',[id.parse(key)]);return {data:users};
 }
 if(resource==='exceptions'&&rawId&&method==='POST'){
  requireRole(actor,'platform_ops');const data=z.object({status:z.enum(['OPEN','IN_REVIEW','RESOLVED']),note:z.string().trim().min(5).max(2000)}).parse(body);return transaction(async db=>{const [record]=await rows('UPDATE portal_exceptions SET status=$2,resolution_note=$3,updated_by=$4,updated_at=now() WHERE id=$1 RETURNING *',[id.parse(rawId),data.status,data.note,actor.id],db);requireCondition(record,404,'Exception not found');await portalEvent(actor,'exception.updated',data.note,record.invoice_id,{exception_id:record.id,status:data.status},db);return {data:record};});
 }
 if(resource==='configuration'){
  requireRole(actor,'platform_ops');if(method==='GET')return {data:await rows('SELECT key,value,updated_at FROM portal_configuration')};
  const data=z.object({key:z.enum(['permissions','programme_parameters','fees','notifications','verification_policies','security_policies','session_policy']),value:z.json()}).parse(body);
  // Captured as a draft; cannot silently override financial/authentication controls.
  await transaction(async db=>{await rows('INSERT INTO portal_configuration(key,value,updated_by) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=$2,updated_by=$3,updated_at=now()',[data.key,JSON.stringify(data.value),actor.id],db);await portalEvent(actor,'configuration.draft_saved',null,null,{key:data.key},db);});return {data:{saved:true,state:'draft'}};
 }
 throw new ApiError(404,'Portal endpoint not found');
}
