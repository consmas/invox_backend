import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID,createHmac } from 'node:crypto';
import {POST as uploadDocument} from '../src/app/api/portal/documents/route';
import {GET as downloadDocument} from '../src/app/api/portal/documents/[id]/route';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import { NextRequest } from 'next/server';
import { handleRequest } from '../src/server/http';
import { pool, rows, insert, transaction } from '../src/server/db';
import {fieldCatalog} from '../src/server/fields';
import { digest } from '../src/server/auth';

const connection = process.env.TEST_DATABASE_URL;
if (!connection || !new URL(connection).pathname.endsWith('_test')) {
  throw new Error('Set TEST_DATABASE_URL to an isolated PostgreSQL database ending in _test. Tests never use DATABASE_URL.');
}
const admin = new Pool({ connectionString:connection });
const schema = `api_test_${process.pid}_${Date.now()}`;
const url = new URL(connection);
url.searchParams.set('options', `-c search_path=${schema}`);
process.env.DATABASE_URL=url.toString();
process.env.APP_URL='http://localhost:3000';
Object.assign(process.env,{NODE_ENV:'test'});
delete process.env.SMTP_URL;
const fixture:Record<string,any>={};
const tokens:Record<string,string>={};
async function request(method:string,path:string,body?:unknown,token?:string,extra:Record<string,string>={}) {
  const res=await handleRequest(new NextRequest(`http://localhost:3000/api/${path}`,{
    method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(token?{cookie:`invoix_token=${token}`} : {}),...extra},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  }),path.split('?')[0].split('/'));
  const text=await res.text();
  return {status:res.status,data:text?JSON.parse(text):null,headers:res.headers};
}
async function login(name:string) {
  const result=await request('POST','auth/login',{email:fixture[name].email,password:'legacy-secret'});
  assert.equal(result.status,200,JSON.stringify(result.data));
  const token=result.headers.get('set-cookie')?.match(/invoix_token=([^;]+)/)?.[1];
  assert.ok(token);tokens[name]=token;return token;
}
function totp(secret:Buffer,offsetSteps=0){const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)+offsetSteps));const hash=createHmac('sha1',secret).update(counter).digest();const offset=hash[19]&15;return String((hash.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');}
const invoiceFields=()=>({invoice_number:randomUUID(),currency:'GHS',issue_date:'2026-01-01',due_date:'2030-12-31',description:'Delivered goods',payment_terms:'Net 30',financing_eligible:true});
const bidFields={currency:'GHS',discount_type:'fixed',discount_fee:'0',other_fees:'0',day_count_basis:'365',expiry_date:'2030-12-01'};
/** Drafts come from the API. Supplier approval and tender publication have their own workflow tests; other tests set them up as fixture state. */
async function createInvoice(status='tender',invited=['financer','otherFinancer']) {
  const result=await request('POST',`buyers/${fixture.buyer.id}/invoices`,{invoice:{...invoiceFields(),programme_id:fixture.programme.id,supplier_id:fixture.supplier.id,amount:'1000.00',status:'draft',due_date:'2030-12-31'}},tokens.ops);
  assert.equal(result.status,201,JSON.stringify(result.data));
  if(status==='draft')return result.data;
  await rows("UPDATE invoices SET status='approved',invoice_approval_status='approved',supplier_approved_at=now(),supplier_approved_by=$2 WHERE id=$1",[result.data.id,fixture.supplierUser.id]);
  if(status==='approved')return {...result.data,status:'approved'};
  const [tender]=await rows("INSERT INTO financing_tenders(invoice_id,programme_id,tender_reference,currency,financing_amount_requested,opens_at,closes_at,maturity_date,eligible_conditions,risk_disclosures,published_by,published_at,status,created_by) VALUES($1,$2,$3,'GHS','1000.00',now(),now()+interval '30 days','2030-12-31','Invited financiers only','Test disclosure',$4,now(),'open',$4) RETURNING id",[result.data.id,fixture.programme.id,`TND-${randomUUID().slice(0,8)}`,fixture.ops.id]);
  for(const name of invited)await rows('INSERT INTO portal_tender_invitations VALUES($1,$2)',[tender.id,fixture[name].id]);
  await rows("UPDATE invoices SET status='tender' WHERE id=$1",[result.data.id]);
  return {...result.data,status:'tender',tender_id:tender.id};
}
before(async()=>{
  process.env.DOCUMENT_STORAGE_PATH=await mkdtemp(join(tmpdir(),'invox-upload-test-'));
  process.env.MFA_SECRET_KEY='a'.repeat(64);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  for(const migration of ['001_next_backend.sql','002_financial_controls.sql','003_requirement_fields.sql','004_additional_control_fields.sql','005_user_profile_fields.sql','006_portal_workflows.sql','007_portal_currencies.sql','008_workflow_management.sql','009_relationship_identifiers.sql','010_document_review.sql','011_security_hardening.sql']) await pool().query(await readFile(new URL('../db/migrations/'+migration,import.meta.url),'utf8'));
  const password=await bcrypt.hash('legacy-secret',4);
  // $2a$ is the bcrypt prefix used by existing Devise accounts.
  const legacy=password.replace('$2b$','$2a$');
  await transaction(async db=>{
    fixture.buyer=await insert('buyers',{name:'Buyer A',registration_number:'A-1',contact_email:'a@example.test'},db);
    fixture.otherBuyer=await insert('buyers',{name:'Buyer B',registration_number:'B-1',contact_email:'b@example.test'},db);
    for(const [name,role,buyer] of [['ops',2,null],['checker',2,null],['buyerAdmin',0,fixture.buyer.id],['otherAdmin',0,fixture.otherBuyer.id],['supplierUser',1,null],['financer',3,null],['otherFinancer',3,null]] as const){
      fixture[name]=await insert('users',{email:`${name.toLowerCase()}@example.test`,encrypted_password:legacy,role,buyer_id:buyer,jti:randomUUID()},db);
    }
    fixture.supplier=await insert('suppliers',{name:'Supplier A',email:fixture.supplierUser.email,user_id:fixture.supplierUser.id},db);
    fixture.programme=await insert('programmes',{name:'Working capital',buyer_id:fixture.buyer.id,limit:'100000',fee_percent:'2',maturity_days:30},db);
  });
  await rows('INSERT INTO portal_programme_financiers VALUES($1,$2)',[fixture.programme.id,fixture.financer.id]);
  await rows('INSERT INTO portal_programme_suppliers VALUES($1,$2)',[fixture.programme.id,fixture.supplier.id]);
  await rows('INSERT INTO portal_supplier_relationships(buyer_id,supplier_id) VALUES($1,$2)',[fixture.buyer.id,fixture.supplier.id]);
  for(const name of ['ops','checker','buyerAdmin','otherAdmin','supplierUser','financer','otherFinancer'])await login(name);
});
after(async()=>{
  await rm(process.env.DOCUMENT_STORAGE_PATH!,{recursive:true,force:true});
  await pool().end();
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
});

test('workflow modules expose scoped full forms and programme release unlocks incomplete invoice drafts',async()=>{
 const reason={reason:'Reviewed commercial configuration'};
 await rows("INSERT INTO financier_profiles(user_id,name,country,institution_type) VALUES($1,'Management test institution','GH','bank') ON CONFLICT(user_id) DO NOTHING",[fixture.financer.id]);
 for(const [name,expected] of [['ops','limits'],['buyerAdmin','conditions_precedent'],['supplierUser','financing_requests'],['financer','mandate_versions']]){
  const modules=await request('GET','portal/modules',undefined,tokens[name]);assert.equal(modules.status,200);assert.ok(modules.data.some((r:any)=>r.key===expected));
  assert.equal((await request('GET',`field-definitions/${expected}`,undefined,tokens[name])).status,200);
 }
 assert.equal((await request('GET','portal/manage/limits',undefined,tokens.buyerAdmin)).status,403);
 const data={name:'Managed programme',buyer_id:fixture.buyer.id,limit:'20000.00',fee_percent:'1',maturity_days:3650,currency:'USD',programme_reference:'MANAGED-TEST',governing_law:'Ghana',jurisdiction:'Accra',buyer_acceptance_authority:'buyer',allocation_policy:'deterministic',supplier_ids:[fixture.supplier.id],financier_ids:[fixture.financer.id]};
 const created=await request('POST','portal/manage/programmes',data,tokens.ops);assert.equal(created.status,201,JSON.stringify(created.data));const programmeId=created.data.id;
 assert.equal((await request('PATCH',`portal/manage/programmes/${programmeId}`,{description:'Complete commercial configuration'},tokens.otherAdmin)).status,404);
 assert.equal((await request('PATCH',`portal/manage/programmes/${programmeId}`,{description:'Complete commercial configuration'},tokens.buyerAdmin)).status,200);
 assert.equal((await request('POST',`portal/manage/programmes/${programmeId}/submit`,reason,tokens.buyerAdmin)).status,200);
 assert.equal((await request('POST',`portal/manage/programmes/${programmeId}/activate`,reason,tokens.buyerAdmin)).status,409);
 const activated=await request('POST',`portal/manage/programmes/${programmeId}/activate`,reason,tokens.ops);assert.equal(activated.status,200,JSON.stringify(activated.data));assert.equal(activated.data.status,'active');
 const draft=await request('POST','portal/manage/invoices',{programme_id:programmeId,supplier_id:fixture.supplier.id,invoice_number:'PARTIAL-DRAFT'},tokens.buyerAdmin);assert.equal(draft.status,201,JSON.stringify(draft.data));assert.equal(draft.data.amount,null);assert.equal(draft.data.currency,'USD');const invoiceId=draft.data.id;
 assert.equal((await request('POST',`portal/manage/invoices/${invoiceId}/submit`,reason,tokens.buyerAdmin)).status,422);
 const completed=await request('PATCH',`portal/manage/invoices/${invoiceId}`,{...invoiceFields(),invoice_number:'COMPLETE-DRAFT',currency:'USD',amount:'1000.00'},tokens.buyerAdmin);assert.equal(completed.status,200,JSON.stringify(completed.data));
 const submitted=await request('POST',`portal/manage/invoices/${invoiceId}/submit`,reason,tokens.buyerAdmin);assert.equal(submitted.status,200,JSON.stringify(submitted.data));
 assert.equal((await request('PATCH',`portal/manage/invoices/${invoiceId}`,{amount:'900'},tokens.buyerAdmin)).status,409);
 assert.equal((await request('DELETE',`portal/manage/invoices/${invoiceId}`,undefined,tokens.buyerAdmin)).status,409);
 assert.equal((await request('POST',`portal/manage/invoices/${invoiceId}/withdraw`,reason,tokens.buyerAdmin)).status,200);
 assert.equal((await request('DELETE',`portal/manage/invoices/${invoiceId}`,undefined,tokens.buyerAdmin)).status,204);
 assert.equal((await request('GET',`invoices/${invoiceId}`,undefined,tokens.buyerAdmin)).status,404);
 assert.ok(!(await request('GET','invoices',undefined,tokens.buyerAdmin)).data.some((i:any)=>i.id===invoiceId));
 assert.ok((await request('GET',`portal/manage/invoices/${invoiceId}`,undefined,tokens.buyerAdmin)).data._actions.restore);
 assert.equal((await request('POST',`portal/manage/invoices/${invoiceId}/restore`,reason,tokens.buyerAdmin)).status,200);
 assert.equal((await request('POST',`portal/manage/invoices/${invoiceId}/submit`,reason,tokens.buyerAdmin)).status,200);
 assert.equal((await request('POST',`portal/invoices/${invoiceId}/decide`,{decision:'approve'},tokens.supplierUser)).status,200);
 const paymentRequest=await request('POST','portal/manage/financing_requests',{invoice_id:invoiceId,requested_amount:'700.00'},tokens.supplierUser);assert.equal(paymentRequest.status,201,JSON.stringify(paymentRequest.data));
 assert.equal((await request('POST',`portal/manage/financing_requests/${paymentRequest.data.id}/submit`,reason,tokens.supplierUser)).status,200);
 assert.equal((await request('PATCH',`portal/manage/financing_requests/${paymentRequest.data.id}`,{requested_amount:'600'},tokens.supplierUser)).status,409);
 assert.equal((await request('POST',`portal/manage/financing_requests/${paymentRequest.data.id}/withdraw`,reason,tokens.supplierUser)).status,200);
 const tender=await request('POST','portal/tenders',{invoice_id:invoiceId,requested_amount:'700',closes_on:'2030-11-01',financier_ids:[fixture.financer.id]},tokens.buyerAdmin);assert.equal(tender.status,201,JSON.stringify(tender.data));
 const edited=await request('PATCH',`portal/manage/tenders/${tender.data.id}`,{eligible_conditions:'Updated disclosure before any offers'},tokens.buyerAdmin);assert.equal(edited.status,200,JSON.stringify(edited.data));
 assert.equal((await request('POST',`portal/manage/tenders/${tender.data.id}/cancel`,reason,tokens.buyerAdmin)).status,200);
 assert.equal((await rows('SELECT status FROM invoices WHERE id=$1',[invoiceId]))[0].status,'approved');
 const relationshipId=(await rows('SELECT id FROM portal_supplier_relationships WHERE buyer_id=$1 AND supplier_id=$2',[fixture.buyer.id,fixture.supplier.id]))[0].id;
 const relation=await request('PATCH',`portal/manage/supplier_relationships/${relationshipId}`,{contact_name:'Accounts contact',contact_email:'accounts@example.test',notes:'Relationship notes'},tokens.buyerAdmin);assert.equal(relation.status,200,JSON.stringify(relation.data));assert.equal(relation.data.contact_name,'Accounts contact');
 const [otherRelationship]=await rows('INSERT INTO portal_supplier_relationships(buyer_id,supplier_id,contact_name) VALUES($1,$2,$3) RETURNING *',[fixture.otherBuyer.id,fixture.supplier.id,'Other buyer contact']);
 assert.notEqual(otherRelationship.id,relationshipId);
 assert.equal((await request('PATCH',`portal/manage/supplier_relationships/${otherRelationship.id}`,{contact_name:'Updated other buyer contact'},tokens.ops)).status,200);
 assert.equal((await rows('SELECT contact_name FROM portal_supplier_relationships WHERE id=$1',[relationshipId]))[0].contact_name,'Accounts contact');
 assert.equal((await request('PATCH',`portal/manage/supplier_relationships/${otherRelationship.id}`,{contact_name:'Cross buyer edit'},tokens.buyerAdmin)).status,404);
 assert.equal((await request('POST',`portal/manage/programmes/${programmeId}/pause`,reason,tokens.buyerAdmin)).status,200);
 const draft2=await request('POST','portal/manage/invoices',{...invoiceFields(),programme_id:programmeId,supplier_id:fixture.supplier.id,currency:'USD',amount:'100'},tokens.buyerAdmin);assert.equal(draft2.status,201,JSON.stringify(draft2.data));
 assert.equal((await request('POST',`portal/manage/invoices/${draft2.data.id}/submit`,reason,tokens.buyerAdmin)).status,409);
});

test('mandates and limits require independent release and acknowledgement; reconciliation does not rewrite money',async()=>{
 const reason={reason:'Independent review completed'};
 const created=await request('POST','portal/manage/mandate_versions',{name:'Mandate test',permitted_countries:['GH'],permitted_sectors:['Trade'],permitted_currencies:['USD'],minimum_tenor_days:1,maximum_tenor_days:120,facility_limit:'20000.00',plain_language_terms:'Only verified receivables within the agreed trade policy.',effective_from:'2026-01-01'},tokens.financer);assert.equal(created.status,201,JSON.stringify(created.data));const id=created.data.id;
 assert.equal((await request('GET',`portal/manage/mandate_versions/${id}`,undefined,tokens.otherFinancer)).status,404);
 assert.equal((await request('POST',`portal/manage/mandate_versions/${id}/submit`,reason,tokens.financer)).status,200);
 assert.equal((await request('PATCH',`portal/manage/mandate_versions/${id}`,{name:'Tampering'},tokens.financer)).status,409);
 assert.equal((await request('POST',`portal/manage/mandate_versions/${id}/approve`,reason,tokens.ops)).status,200);
 assert.equal((await request('POST',`portal/manage/mandate_versions/${id}/accept`,reason,tokens.financer)).status,422);
 const accepted=await request('POST',`portal/manage/mandate_versions/${id}/accept`,{...reason,acknowledged:true},tokens.financer);assert.equal(accepted.status,200,JSON.stringify(accepted.data));assert.equal(accepted.data.status,'active');
 const limit=await request('POST','portal/manage/limits',{scope_type:'programme',scope_id:fixture.programme.id,limit_type:'facility',amount:'10000',currency:'GHS',effective_from:'2026-01-01',authority_reference:'Credit committee 001'},tokens.ops);assert.equal(limit.status,201,JSON.stringify(limit.data));
 assert.equal((await request('POST',`portal/manage/limits/${limit.data.id}/submit`,reason,tokens.ops)).status,200);
 assert.equal((await request('POST',`portal/manage/limits/${limit.data.id}/approve`,reason,tokens.ops)).status,409);
 assert.equal((await request('POST',`portal/manage/limits/${limit.data.id}/approve`,reason,tokens.checker)).status,200);
 const before=(await rows('SELECT count(*) FROM ledger_journals'))[0].count;
 const investigation=await request('POST','portal/manage/reconciliation_cases',{bank_reference:'UNMATCHED-001',expected_amount:'100',actual_amount:'90',currency:'USD',difference_reason:'Bank amount differs',owner_id:fixture.ops.id,due_at:'2030-12-01T12:00:00Z'},tokens.ops);assert.equal(investigation.status,201,JSON.stringify(investigation.data));
 const resolved=await request('POST',`portal/manage/reconciliation_cases/${investigation.data.id}/resolve`,reason,tokens.ops);assert.equal(resolved.status,200,JSON.stringify(resolved.data));assert.equal(resolved.data.status,'resolved');
 assert.equal((await rows('SELECT count(*) FROM ledger_journals'))[0].count,before);
});

test('access management disables accounts without losing history or allowing cross-organisation changes',async()=>{
 const created=await request('POST','portal/manage/users',{email:'managed-member@example.test',password:'managed-password-123',password_confirmation:'managed-password-123',name:'Buyer colleague'},tokens.buyerAdmin);assert.equal(created.status,201,JSON.stringify(created.data));const id=created.data.id;
 assert.ok(!JSON.stringify(created.data).includes('encrypted_password'));
 const token=(await request('POST','auth/login',{email:'managed-member@example.test',password:'managed-password-123'})).headers.get('set-cookie')?.match(/invoix_token=([^;]+)/)?.[1];assert.ok(token);
 assert.equal((await request('DELETE',`portal/manage/users/${id}`,undefined,tokens.otherAdmin)).status,404);
 assert.equal((await request('DELETE',`portal/manage/users/${fixture.buyerAdmin.id}`,undefined,tokens.buyerAdmin)).status,409);
 assert.equal((await request('DELETE',`portal/manage/users/${id}`,undefined,tokens.buyerAdmin)).status,204);
 assert.equal((await request('GET','auth/me',undefined,token)).data.user,null);
 assert.equal((await request('POST','auth/login',{email:'managed-member@example.test',password:'managed-password-123'})).status,401);
 assert.equal((await request('POST',`portal/manage/users/${id}/restore`,{reason:'Restore access after reviewed approval'},tokens.buyerAdmin)).status,200);
 assert.equal((await request('GET','auth/me',undefined,token)).data.user,null);
});

test('all management lists load; conditions and retained evidence use independent state transitions',async()=>{
 const reason={reason:'Evidence checked independently'};
 const modules=await request('GET','portal/modules',undefined,tokens.ops);
 for(const entry of modules.data){const result=await request('GET',`portal/manage/${entry.key}`,undefined,tokens.ops);assert.equal(result.status,200,`${entry.key}: ${JSON.stringify(result.data)}`);}
 const form=new FormData();form.set('file',new File(['%PDF-1.4\nmanagement evidence'], 'management-evidence.pdf',{type:'application/pdf'}));
 const uploaded=await uploadDocument(new NextRequest('http://localhost:3000/api/portal/documents',{method:'POST',headers:{cookie:`invoix_token=${tokens.buyerAdmin}`},body:form}));assert.equal(uploaded.status,201);const doc=await uploaded.json();
 const condition=await request('POST','portal/manage/conditions_precedent',{programme_id:fixture.programme.id,description:'Executed supplier participation agreement',owner_id:fixture.buyerAdmin.id,mandatory:true,due_date:'2030-01-01',evidence_id:doc.id},tokens.buyerAdmin);assert.equal(condition.status,201,JSON.stringify(condition.data));
 assert.equal((await request('DELETE',`portal/manage/documents/${doc.id}`,undefined,tokens.buyerAdmin)).status,409);
 assert.equal((await request('POST',`portal/manage/conditions_precedent/${condition.data.id}/satisfy`,reason,tokens.buyerAdmin)).status,409);
 assert.equal((await request('POST',`portal/manage/conditions_precedent/${condition.data.id}/satisfy`,reason,tokens.ops)).status,409);
 assert.equal((await request('POST',`portal/document-reviews/${doc.id}`,{decision:'verify'},tokens.checker)).status,200);
 const satisfied=await request('POST',`portal/manage/conditions_precedent/${condition.data.id}/satisfy`,reason,tokens.ops);assert.equal(satisfied.status,200,JSON.stringify(satisfied.data));assert.equal(satisfied.data.status,'satisfied');
 assert.equal((await request('PATCH',`portal/manage/conditions_precedent/${condition.data.id}`,{description:'Changed after approval'},tokens.ops)).status,409);
 // Financiers cannot enumerate unrelated programme names through a lookup endpoint.
 const hidden=await request('POST','portal/manage/programmes',{buyer_id:fixture.otherBuyer.id,name:'Confidential programme',currency:'GHS'},tokens.ops);assert.equal(hidden.status,201,JSON.stringify(hidden.data));
 const options=await request('GET','portal/manage/mandate_versions/options/programmes',undefined,tokens.financer);assert.equal(options.status,200);assert.ok(!options.data.some((p:any)=>p.id===hidden.data.id));
 const exception=await request('POST','portal/manage/exceptions',{kind:'DISPUTE',summary:'Investigate disputed delivery confirmation'},tokens.ops);assert.equal(exception.status,201);
 assert.equal((await request('POST',`portal/manage/exceptions/${exception.data.id}/resolve`,reason,tokens.ops)).status,200);
});

test('health, authentication, origin checks, and invalid JSON',async()=>{
  assert.equal((await request('GET','health')).status,200);
  assert.equal((await request('GET','buyers')).status,401);
  assert.equal((await request('POST','auth/login',{email:fixture.ops.email,password:'legacy-secret'},undefined,{origin:'https://attacker.example'})).status,403);
  const invalid=await handleRequest(new NextRequest('http://localhost:3000/api/auth/login',{method:'POST',body:'not-json'}),['auth','login']);
  assert.equal(invalid.status,400);
});
test('Devise password hashes remain valid and session identity comes from the database',async()=>{
  const me=await request('GET','auth/me',undefined,tokens.ops);
  assert.equal(me.data.user.role,'platform_ops');
  assert.equal(me.data.user.id,fixture.ops.id);
  assert.equal(JSON.stringify(me.data).includes('encrypted_password'),false);
  assert.equal((await request('GET','auth/me',undefined,'unsigned.jwt.token')).data.user,null);
  const cookie=(await request('POST','auth/login',{email:fixture.ops.email,password:'legacy-secret'})).headers.get('set-cookie')!;
  assert.match(cookie,/HttpOnly/i);assert.match(cookie,/SameSite=lax/i);
});
test('public signup creates an isolated buyer organization and rejects privileged roles',async()=>{
  const body={email:'newbuyer@example.test',password:'new-password-123',role:'buyer_admin',name:'New buyer',registration_number:'NEW-1',country:'GH'};
  const result=await request('POST','auth/signup',body);
  assert.equal(result.status,201,JSON.stringify(result.data));assert.ok(result.data.user.buyer_id);
  assert.equal((await request('POST','auth/signup',{...body,email:'attacker@example.test',role:'platform_ops'})).status,403);
  assert.equal((await request('POST','auth/signup',{...body,email:'publicsupplier@example.test',role:'supplier_user'})).status,403);
});
test('buyer and programme routes enforce organization boundaries and nested user roles',async()=>{
  assert.equal((await request('GET',`buyers/${fixture.buyer.id}`,undefined,tokens.otherAdmin)).status,403);
  assert.equal((await request('PATCH',`buyers/${fixture.buyer.id}/programmes/${fixture.programme.id}`,{programme:{name:'Hijacked'}},tokens.otherAdmin)).status,403);
  assert.equal((await request('PATCH',`buyers/${fixture.buyer.id}`,{buyer:{users_attributes:[{email:'privileged@example.test',password:'new-password-123',role:'platform_ops'}]}},tokens.buyerAdmin)).status,403);
  const added=await request('PATCH',`buyers/${fixture.buyer.id}`,{buyer:{users_attributes:[{email:'newadmin@example.test',password:'new-password-123',role:'buyer_admin'}]}},tokens.ops);
  assert.equal(added.status,200,JSON.stringify(added.data));assert.ok(added.data.users.some((u:any)=>u.email==='newadmin@example.test'));
  assert.equal(added.data.users.some((u:any)=>'encrypted_password'in u),false);
});
test('buyer creation accepts the existing frontend users payload atomically',async()=>{
  const body={buyer:{name:'Created together',country:'GH',registration_number:'TOGETHER',contact_email:'together@example.test',users:[{email:'together@example.test',password:'new-password-123',role:'buyer_admin'}]}};
  const result=await request('POST','buyers',body,tokens.ops);
  assert.equal(result.status,201,JSON.stringify(result.data));assert.equal(result.data.users.length,1);
  const fail=await request('POST','buyers',{buyer:{...body.buyer,registration_number:'ROLLBACK',users:[{email:fixture.ops.email,password:'new-password-123',role:'buyer_admin'}]}},tokens.ops);
  assert.equal(fail.status,409);assert.equal((await rows("SELECT id FROM buyers WHERE registration_number='ROLLBACK'")).length,0);
});
test('supplier profile IDs and persisted invoice status are consistent',async()=>{
  const invoice=await createInvoice();fixture.invoice=invoice;
  assert.notEqual(String(fixture.supplier.id),String(fixture.supplierUser.id));
  const result=await request('GET',`invoices/${invoice.id}`,undefined,tokens.supplierUser);
  assert.equal(result.status,200);assert.equal(result.data.status,'tender');assert.equal(String(result.data.supplier.id),String(fixture.supplier.id));
  assert.equal((await request('GET',`invoices/${invoice.id}`,undefined,tokens.otherAdmin)).status,403);
  assert.equal((await request('POST',`buyers/${fixture.otherBuyer.id}/invoices`,{invoice:{...invoiceFields(),programme_id:fixture.programme.id,supplier_id:fixture.supplier.id,amount:'10',status:'draft'}},tokens.ops)).status,404);
});
test('global, nested, programme-scoped, and v1 invoice routes resolve consistently',async()=>{
  for(const path of ['invoices',`buyers/${fixture.buyer.id}/invoices`,`programmes/${fixture.programme.id}/invoices`,'v1/invoices']){
    const result=await request('GET',path,undefined,tokens.ops);assert.equal(result.status,200,`${path}: ${JSON.stringify(result.data)}`);assert.ok(result.data.some((i:any)=>String(i.id)===String(fixture.invoice.id)));
  }
  assert.equal((await request('PATCH',`buyers/${fixture.buyer.id}/invoices/${fixture.invoice.id}`,{invoice:{due_date:'2031-01-01'}},tokens.ops)).status,409);
  const draft=await createInvoice('draft');
  const changed=await request('PATCH',`buyers/${fixture.buyer.id}/invoices/${draft.id}`,{invoice:{due_date:'2031-01-01'}},tokens.ops);
  assert.equal(changed.status,200,JSON.stringify(changed.data));assert.equal(changed.data.status,'draft');
});
test('validation rejects invalid money, dates, and unsupported status transitions',async()=>{
  for(const amount of ['-1','0','1.001','NaN']){
    const bad=await request('POST','invoices',{invoice:{programme_id:fixture.programme.id,supplier_id:fixture.supplier.id,amount,status:'draft'}},tokens.ops);
    assert.equal(bad.status,422);
  }
  const invoice=await createInvoice('draft');
  assert.equal((await request('PATCH',`invoices/${invoice.id}`,{invoice:{status:'funded'}},tokens.ops)).status,409);
  assert.equal((await request('PATCH',`invoices/${invoice.id}`,{invoice:{due_date:'2030-02-31'}},tokens.ops)).status,422);
});
test('financer-only bidding persists updates and hides competing bids',async()=>{
  const invoice=fixture.invoice;
  assert.equal((await request('POST',`invoices/${invoice.id}/bids`,{bid:{...bidFields,amount:'950'}},tokens.supplierUser)).status,403);
  const first=await request('POST',`buyers/${fixture.buyer.id}/invoices/${invoice.id}/bids`,{bid:{...bidFields,amount:'950',expiry_date:'2030-12-01'}},tokens.financer);
  assert.equal(first.status,201,JSON.stringify(first.data));fixture.firstBid=first.data;
  const second=await request('POST',`invoices/${invoice.id}/bids`,{bid:{...bidFields,amount:'940'}},tokens.otherFinancer);
  assert.equal(second.status,201);fixture.secondBid=second.data;
  const changed=await request('PATCH',`bids/${first.data.id}`,{bid:{...bidFields,amount:'925'}},tokens.financer);
  assert.equal(changed.status,200);assert.equal(Number(changed.data.amount),925);
  const list=await request('GET',`invoices/${invoice.id}/bids`,undefined,tokens.financer);
  assert.equal(list.data.length,1);assert.equal(String(list.data[0].financer_id),String(fixture.financer.id));
  assert.equal((await request('PATCH',`bids/${first.data.id}/accept`,{},tokens.financer)).status,403);
  assert.equal((await request('GET',`financers/${fixture.financer.id}/bids`,undefined,tokens.financer)).status,200);
  assert.equal((await request('GET','bids',undefined,tokens.buyerAdmin)).status,200);
});
test('simultaneous acceptance locks one offer without claiming disbursement',async()=>{
  const results=await Promise.all([fixture.firstBid,fixture.secondBid].map(bid=>request('PATCH',`bids/${bid.id}/accept`,{},tokens.buyerAdmin)));
  assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
  const list=await request('GET',`invoices/${fixture.invoice.id}/bids`,undefined,tokens.ops);
  assert.equal(list.data.filter((bid:any)=>bid.status==='accepted').length,1);
  assert.equal(list.data.filter((bid:any)=>bid.status==='rejected').length,1);
  const invoice=await request('GET',`invoices/${fixture.invoice.id}`,undefined,tokens.ops);assert.equal(invoice.data.status,'tender');
  assert.equal((await request('DELETE',`invoices/${fixture.invoice.id}`,undefined,tokens.ops)).status,409);
  const winner=list.data.find((bid:any)=>bid.status==='accepted');fixture.winningBid=winner;
  assert.equal((await request('GET',`financers/${winner.financer_id}/portfolio`,undefined,tokens.ops)).data.length,0);
  assert.equal((await request('PATCH',`invoices/${fixture.invoice.id}`,{invoice:{status:'repaid'}},tokens.ops)).status,409);
});
test('agreement and verified disbursement require independent actors and idempotency',async()=>{
  const invoice=fixture.invoice.id;
  const proposal={currency:'GHS',agreement_reference:'AGR-TEST-001',governing_law:'Ghana',jurisdiction:'Ghana',recourse_type:'non_recourse',net_disbursement:fixture.winningBid.net_supplier_proceeds,repayment_amount:'1000.00',maturity_date:'2030-12-31',document_reference:'evidence://signed-contract-001',idempotency_key:'agreement-proposal-001'};
  assert.equal((await request('POST',`invoices/${invoice}/agreements`,proposal,tokens.buyerAdmin)).status,403);
  const rejected=await request('POST',`invoices/${invoice}/agreements`,{...proposal,idempotency_key:'incorrect-agreement-draft'},tokens.ops);
  assert.equal(rejected.status,201);
  assert.equal((await request('POST',`agreements/${rejected.data.id}/reject`,{idempotency_key:'agreement-independent-reject'},tokens.checker)).status,201);
  const agreed=await request('POST',`invoices/${invoice}/agreements`,proposal,tokens.ops);
  assert.equal(agreed.status,201,JSON.stringify(agreed.data));fixture.agreement=agreed.data;
  assert.equal((await request('POST',`agreements/${agreed.data.id}/sign`,{idempotency_key:'self-agreement-check'},tokens.ops)).status,403);
  assert.equal((await request('POST',`agreements/${agreed.data.id}/sign`,{idempotency_key:'independent-sign-001'},tokens.checker)).status,201);
  const proof={payment_reference:'DISBURSE-001',evidence_reference:'evidence://bank-confirmed-disbursement',payment_date:new Date().toISOString().slice(0,10),idempotency_key:'disbursement-record-001'};
  const recorded=await request('POST',`invoices/${invoice}/fundings`,proof,tokens.ops);
  assert.equal(recorded.status,201,JSON.stringify(recorded.data));fixture.funding=recorded.data;
  const repeated=await request('POST',`invoices/${invoice}/fundings`,proof,tokens.ops);
  assert.equal(repeated.status,200);assert.equal(repeated.data.id,recorded.data.id);
  assert.equal((await request('POST',`invoices/${invoice}/fundings`,{...proof,payment_reference:'changed'},tokens.ops)).status,409);
  assert.equal((await request('GET',`invoices/${invoice}`,undefined,tokens.ops)).data.status,'tender');
  const loser=String(fixture.winningBid.financer_id)===String(fixture.financer.id)?tokens.otherFinancer:tokens.financer;
  assert.equal((await request('GET',`invoices/${invoice}/financials`,undefined,loser)).status,404);
  assert.equal((await request('POST',`fundings/${recorded.data.id}/confirm`,{idempotency_key:'self-payment-check'},tokens.ops)).status,403);
  assert.equal((await request('POST',`fundings/${recorded.data.id}/confirm`,{idempotency_key:'funding-confirm-001'},tokens.checker)).status,201);
  assert.equal((await request('GET',`invoices/${invoice}`,undefined,tokens.ops)).data.status,'funded');
  assert.equal((await request('PATCH',`invoices/${invoice}`,{invoice:{status:'repaid'}},tokens.ops)).status,409);
  const position=(await request('GET',`invoices/${invoice}/financials`,undefined,tokens.ops)).data.position;
  assert.equal(position.outstanding_amount,'1000.00');assert.equal(position.received_amount,'0.00');
});
test('partial receipts serialize, refuse overpayment, settle fully and reverse without destructive edits',async()=>{
  const invoice=fixture.invoice.id;
  const base={currency:'GHS',amount:'600.00',payment_date:new Date().toISOString().slice(0,10),evidence_reference:'evidence://received-bank-transfer'};
  assert.equal((await request('POST',`invoices/${invoice}/repayments`,{...base,currency:'USD',payment_reference:'WRONG-CURRENCY',idempotency_key:'wrong-currency-receipt'},tokens.buyerAdmin)).status,422);
  const receipts=await Promise.all([1,2].map(n=>request('POST',`invoices/${invoice}/repayments`,{...base,payment_reference:`RECEIPT-${n}`,idempotency_key:`record-receipt-${n}`},tokens.buyerAdmin)));
  assert.deepEqual(receipts.map(r=>r.status),[201,201]);
  assert.equal((await request('GET',`invoices/${invoice}/financials`,undefined,tokens.ops)).data.position.outstanding_amount,'1000.00');
  const decisions=await Promise.all(receipts.map((r,n)=>request('POST',`repayments/${r.data.id}/confirm`,{idempotency_key:`confirm-receipt-${n}`},tokens.checker)));
  assert.deepEqual(decisions.map(r=>r.status).sort(),[201,409]);
  const failed=receipts[decisions.findIndex(r=>r.status===409)];
  assert.equal((await request('POST',`repayments/${failed.data.id}/reject`,{idempotency_key:'reject-overpayment'},tokens.ops)).status,201);
  assert.equal((await request('GET',`invoices/${invoice}/financials`,undefined,tokens.ops)).data.position.outstanding_amount,'400.00');
  const last=await request('POST',`invoices/${invoice}/repayments`,{...base,amount:'400.00',payment_reference:'RECEIPT-FINAL',idempotency_key:'record-final-receipt'},tokens.buyerAdmin);
  assert.equal((await request('POST',`repayments/${last.data.id}/confirm`,{idempotency_key:'confirm-final-receipt'},tokens.ops)).status,201);
  assert.equal((await request('GET',`invoices/${invoice}`,undefined,tokens.ops)).data.status,'repaid');
  const reversal=await request('POST',`invoices/${invoice}/repayments/${last.data.id}/reverse`,{payment_reference:'BANK-REVERSAL-FINAL',payment_date:base.payment_date,evidence_reference:'evidence://bank-return-notice',reason:'Bank returned the final receipt',idempotency_key:'record-bank-reversal'},tokens.ops);
  assert.equal(reversal.status,201,JSON.stringify(reversal.data));
  assert.equal((await request('POST',`repayments/${reversal.data.id}/confirm`,{idempotency_key:'self-reversal-confirm'},tokens.ops)).status,403);
  assert.equal((await request('POST',`repayments/${reversal.data.id}/confirm`,{idempotency_key:'confirm-bank-reversal'},tokens.checker)).status,201);
  const financials=(await request('GET',`invoices/${invoice}/financials`,undefined,tokens.supplierUser)).data;
  assert.equal(financials.invoice_status,'funded');assert.equal(financials.position.outstanding_amount,'400.00');assert.equal(financials.position.received_amount,'600.00');
  assert.ok(financials.events.some((event:any)=>event.event==='repayment.reversal_confirmed'));
  assert.equal((await request('GET',`invoices/${invoice}/financials`,undefined,tokens.otherAdmin)).status,404);
  await assert.rejects(rows('UPDATE repayments SET amount=1 WHERE id=$1',[last.data.id]),/cannot be edited/);
  await assert.rejects(rows('DELETE FROM audit_events WHERE invoice_id=$1',[invoice]),/append-only/);
  await assert.rejects(rows('UPDATE ledger_lines SET amount=1'),/append-only/);
  const totals=await rows(`SELECT j.id,sum(CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END)::text AS balance FROM ledger_journals j JOIN ledger_lines l ON l.journal_id=j.id GROUP BY j.id`);
  assert.ok(totals.length>=4);assert.ok(totals.every(total=>total.balance==='0.00'));
});
test('unbalanced journals roll back and production execution has no feature-flag bypass',async()=>{
  await assert.rejects(transaction(async db=>{
    const [journal]=await rows("INSERT INTO ledger_journals(invoice_id,source_type,source_id,currency) VALUES($1,'receipt',999999,'GHS') RETURNING id",[fixture.invoice.id],db);
    await rows("INSERT INTO ledger_lines(journal_id,account_code,side,amount) VALUES($1,'buyer_obligation','debit',1)",[journal.id],db);
  }),/balanced/);
  const previous=process.env.NODE_ENV;Object.assign(process.env,{NODE_ENV:'production'});
  try{
    // Production: an operations session without a verified authenticator is restricted to enrolment (F24)…
    assert.equal((await request('POST',`invoices/${fixture.invoice.id}/repayments`,{idempotency_key:'production-forbidden'},tokens.ops)).status,403);
    assert.equal((await request('GET','portal/session',undefined,tokens.ops)).data.mfa_enrolment_required,true);
    // …and even an MFA-verified session cannot execute financial actions while the release guard is on (F22).
    await rows('UPDATE app_sessions SET mfa_verified_at=now() WHERE token_hash=$1',[digest(tokens.ops)]);
    assert.equal((await request('POST',`invoices/${fixture.invoice.id}/repayments`,{idempotency_key:'production-forbidden'},tokens.ops)).status,503);
  }
  finally{Object.assign(process.env,{NODE_ENV:previous});}
});
test('deletes return empty 204 responses and nested mismatches are rejected',async()=>{
  const invoice=await createInvoice();
  const bid=await request('POST',`invoices/${invoice.id}/bids`,{bid:{...bidFields,amount:'900'}},tokens.financer);
  assert.equal(bid.status,201);
  assert.equal((await request('GET',`invoices/${fixture.invoice.id}/bids/${bid.data.id}`,undefined,tokens.ops)).status,404);
  const result=await request('DELETE',`bids/${bid.data.id}`,undefined,tokens.financer);assert.equal(result.status,204);assert.equal(result.data,null);
  const [withdrawn]=await rows('SELECT status,portal_state FROM bids WHERE id=$1',[bid.data.id]);assert.equal(withdrawn.portal_state,'WITHDRAWN');
  assert.ok((await rows("SELECT 1 FROM audit_events WHERE record_id=$1 AND event='bid.withdrawn'",[String(bid.data.id)])).length);
  assert.equal((await request('DELETE',`invoices/${invoice.id}`,undefined,tokens.ops)).status,409);
  const draft=await createInvoice('draft');
  assert.equal((await request('DELETE',`invoices/${draft.id}`,undefined,tokens.ops)).status,204);
});
test('financer CRUD and sensitive user updates retain roles and revoke sessions',async()=>{
  const result=await request('POST','financers',{financer:{name:'Test lender',registration_number:'LENDER-1',institution_type:'bank',country:'GH',contact_email:'lender@example.test',email:'createdfinancer@example.test',password:'new-password-123'}},tokens.ops);
  assert.equal(result.status,201,JSON.stringify(result.data));const account=result.data;assert.equal(account.name,'Test lender');assert.equal(account.registration_number,'LENDER-1');assert.equal('encrypted_password' in account,false);
  assert.equal((await request('GET',`financers/${account.id}`,undefined,tokens.ops)).status,200);
  assert.equal((await request('PATCH',`financers/${account.id}`,{financer:{email:'updatedfinancer@example.test'}},tokens.ops)).data.role,'financer');
  assert.equal((await request('DELETE',`financers/${account.id}`,undefined,tokens.ops)).status,204);
  const token=await login('otherAdmin');
  const changed=await request('PATCH',`users/${fixture.otherAdmin.id}`,{user:{password:'changed-password-123'}},tokens.ops);
  assert.equal(changed.status,200);assert.equal(changed.data.role,'buyer_admin');
  assert.equal((await request('GET','auth/me',undefined,token)).data.user,null);
});
test('supplier invitations are single-use, expire, and never expose hashes',async()=>{
  const result=await request('POST','suppliers',{supplier:{name:'Invited supplier',country:'GH',contact_email:'invite@example.test',invite:'invite',password:'',password_confirmation:''}},tokens.ops);
  assert.equal(result.status,201,JSON.stringify(result.data));assert.ok(result.data.preview_url);assert.equal('invitation_token'in result.data,false);
  const token=new URL(result.data.preview_url).pathname.split('/').pop()!;
  assert.equal((await request('GET',`auth/invite?token=${token}`)).status,200);
  const body={email:'invite@example.test',password:'invited-password-123',role:'supplier_user',invite_token:token};
  assert.equal((await request('POST','auth/signup',{...body,email:'wrong@example.test'})).status,422);
  const accepted=await request('POST','auth/signup',body);assert.equal(accepted.status,201,JSON.stringify(accepted.data));
  assert.equal((await request('POST','auth/signup',body)).status,422);
  const updated=await request('PATCH',`suppliers/${result.data.id}`,{supplier:{contact_email:'changedinvite@example.test'}},tokens.ops);
  assert.equal(updated.status,200);assert.equal(updated.data.email,'changedinvite@example.test');
  const reissued=await request('POST',`suppliers/${result.data.id}/invite`,{},tokens.ops);
  assert.equal(reissued.status,200,JSON.stringify(reissued.data));
  const replacement=new URL(reissued.data.preview_url).pathname.split('/').pop()!;
  assert.equal((await request('GET',`auth/invite?token=${token}`)).status,404);
  await rows("UPDATE suppliers SET invitation_expires_at=now()-interval '1 minute' WHERE id=$1",[result.data.id]);
  assert.equal((await request('GET',`auth/invite?token=${replacement}`)).status,404);
  assert.equal((await request('POST','auth/signup',{...body,email:'changedinvite@example.test',invite_token:replacement})).status,422);
});
test('field catalogue matches every persisted column and restricts control administration',async()=>{
  const columns=await rows('SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1',[schema]);
  const available=new Set(columns.map(row=>`${row.table_name}.${row.column_name}`));
  for(const definition of Object.values(fieldCatalog)){
    const table=definition.key==='financers'?'financier_profiles':definition.key==='agreements'?'financing_agreements':definition.key;
    for(const field of definition.fields){if(field.transient||definition.key==='financers'&&field.key==='email')continue;assert.ok(available.has(`${table}.${definition.key==='suppliers'&&field.key==='contact_email'?'email':field.key}`),`${table}.${field.key} must persist`);}
  }
  const ops=await request('GET','field-definitions',undefined,tokens.ops);assert.equal(ops.status,200);assert.equal(ops.data.length,Object.keys(fieldCatalog).length);
  const buyer=await request('GET','field-definitions',undefined,tokens.buyerAdmin);assert.ok(buyer.data.every((entity:any)=>entity.core));
  assert.equal((await request('GET','field-definitions/mandate_versions',undefined,tokens.buyerAdmin)).status,403);
  assert.equal((await request('GET','controls/documents',undefined,tokens.buyerAdmin)).status,403);
  assert.equal((await request('POST','controls/not_a_table',{},tokens.ops)).status,404);
});
test('user profile fields persist and assurance fields cannot be forged',async()=>{
 const saved=await request('PATCH',`users/${fixture.buyerAdmin.id}`,{user:{name:'Buyer administrator',contact_phone:'+233200000001',country:'gh',preferred_language:'en',timezone:'Africa/Accra',recert_cycle:6}},tokens.ops);assert.equal(saved.status,200,JSON.stringify(saved.data));assert.equal(saved.data.name,'Buyer administrator');assert.equal(saved.data.country,'GH');
 assert.equal((await request('PATCH',`users/${fixture.buyerAdmin.id}`,{user:{mfa_verified_at:new Date().toISOString()}},tokens.ops)).status,403);assert.equal(JSON.stringify(saved.data).includes('encrypted_password'),false);
});
test('organisation and programme fields persist without granting review status',async()=>{
  const updated=await request('PATCH',`buyers/${fixture.buyer.id}`,{buyer:{legal_name:'Buyer legal company',country:'gh',tax_id:'TAX-123',contact_phone:'+233200000000',preferred_language:'en'}},tokens.ops);
  assert.equal(updated.status,200,JSON.stringify(updated.data));assert.equal(updated.data.country,'GH');assert.equal(updated.data.tax_id,'TAX-123');
  for(const key of ['verification_status','last_verified_at','risk_rating'])assert.equal((await request('PATCH',`buyers/${fixture.buyer.id}`,{buyer:{[key]:'verified'}},tokens.ops)).status,403);
  const programme=await request('POST',`buyers/${fixture.buyer.id}/programmes`,{programme:{name:'Detailed programme',limit:'500000',fee_percent:'2.5',maturity_days:90,programme_reference:'PRG-COVERAGE',currency:'USD',governing_law:'Ghana',jurisdiction:'Ghana',margin_rate:'3.250000',dilution_cap_percent:'5',risk_disclosures:'Rates may change',effective_from:'2026-01-01',effective_to:'2030-12-31'}},tokens.ops);
  assert.equal(programme.status,201,JSON.stringify(programme.data));assert.equal(programme.data.currency,'USD');assert.equal(programme.data.margin_rate,'3.250000');
  assert.equal((await request('PATCH',`programmes/${programme.data.id}`,{programme:{governing_law:null}},tokens.ops)).status,422);
  assert.equal((await request('PATCH',`programmes/${programme.data.id}`,{programme:{released_by:fixture.ops.id}},tokens.ops)).status,403);
  await assert.rejects(rows('DELETE FROM entity_audit_events WHERE entity=$1',['buyers']),/append-only/);
});
test('document references, ownership, draft control records and relationship validation',async()=>{
  const documentBody={buyer_id:fixture.buyer.id,category:'invoice',file_name:'invoice-evidence.pdf',mime_type:'application/pdf',size_bytes:1024,storage_key:'private/evidence-001',sha256:'a'.repeat(64)};
  const document=await request('POST','controls/documents',documentBody,tokens.ops);assert.equal(document.status,201,JSON.stringify(document.data));assert.equal(document.data.scan_status,'pending');
  assert.equal((await request('PATCH',`controls/documents/${document.data.id}`,{scan_status:'clean'},tokens.ops)).status,403);
  const other=await request('POST','controls/documents',{...documentBody,buyer_id:fixture.otherBuyer.id,storage_key:'private/evidence-other'},tokens.ops);assert.equal(other.status,201);
  const invoice=await createInvoice('draft');
  const patch={description:'Verified goods description',purchase_order_reference:'PO-456',delivery_reference:'DEL-789',tax_amount:'12.34',supporting_documents:[{document_id:document.data.id,description:'Delivery evidence'}]};
  const saved=await request('PATCH',`invoices/${invoice.id}`,{invoice:patch},tokens.buyerAdmin);assert.equal(saved.status,200,JSON.stringify(saved.data));assert.deepEqual(saved.data.supporting_documents,patch.supporting_documents);assert.equal(saved.data.tax_amount,'12.34');
  assert.equal((await request('PATCH',`invoices/${invoice.id}`,{invoice:{supporting_documents:[{document_id:other.data.id}]}},tokens.buyerAdmin)).status,403);
  const lookups=await request('GET','lookups/documents',undefined,tokens.buyerAdmin);assert.ok(lookups.data.some((row:any)=>row.id===document.data.id));assert.ok(!lookups.data.some((row:any)=>row.id===other.data.id));
  const mismatch=await request('POST','controls/trade_evidence',{invoice_id:invoice.id,document_id:document.data.id,evidence_type:'delivery_note',verified_by:fixture.ops.id},tokens.ops);assert.equal(mismatch.status,403);
  const reconciliation=await request('POST','controls/reconciliation_runs',{buyer_id:fixture.otherBuyer.id,as_at:'2026-11-10',source_count:1,source_total:'1000'},tokens.ops);assert.equal(reconciliation.status,201,JSON.stringify(reconciliation.data));
  const invalid=await request('POST','controls/funding_decisions',{invoice_id:invoice.id,programme_id:fixture.programme.id,buyer_id:fixture.otherBuyer.id},tokens.ops);assert.ok([422,403].includes(invalid.status));
  assert.equal((await request('POST','controls/bank_accounts',{},tokens.ops)).status,403);
  const mandate=await request('POST','controls/mandate_versions',{financier_id:fixture.financer.id,name:'Ghana mandate',permitted_countries:['GH'],permitted_sectors:['manufacturing'],permitted_currencies:['GHS'],maximum_tenor_days:120,facility_limit:'1000000',plain_language_terms:'Ghana manufacturing receivables up to 120 days',effective_from:'2026-01-01',effective_to:'2030-12-31',parameters:{limits:{buyer:'10000'}}},tokens.ops);
  assert.equal(mandate.status,201,JSON.stringify(mandate.data));assert.deepEqual(mandate.data.parameters,{limits:{buyer:'10000'}});assert.equal(mandate.data.status,'draft');
  assert.equal((await request('PATCH',`controls/mandate_versions/${mandate.data.id}`,{effective_to:'2025-01-01'},tokens.ops)).status,422);
});
test('bid fields use server calculations and cannot overwrite computed amounts',async()=>{
  const invoice=await createInvoice();const endpoint=`invoices/${invoice.id}`;
  const input={...bidFields,amount:'1000.00',discount_type:'flat',discount_rate:'2.500000',other_fees:'5.00',additional_conditions:'Payment after independently verified execution',payment_timing:'next_business_day'};
  const preview=await request('POST',`${endpoint}/bid-quote`,{bid:input},tokens.financer);assert.equal(preview.status,200,JSON.stringify(preview.data));assert.equal(preview.data.net_supplier_proceeds,'970.00');
  assert.equal((await rows('SELECT id FROM bids WHERE invoice_id=$1',[invoice.id])).length,0);
  const bid=await request('POST',`${endpoint}/bids`,{bid:input},tokens.financer);assert.equal(bid.status,201,JSON.stringify(bid.data));assert.equal(bid.data.discount_fee,'25.00');assert.equal(bid.data.net_supplier_proceeds,'970.00');assert.equal(bid.data.pricing_snapshot.rate,'2.500000');
  assert.equal((await request('PATCH',`bids/${bid.data.id}`,{bid:{net_supplier_proceeds:'1000'}},tokens.financer)).status,403);
  assert.equal((await request('POST',`${endpoint}/bid-quote`,{bid:{...input,currency:'USD'}},tokens.financer)).status,422);
  assert.equal((await request('POST',`${endpoint}/bid-quote`,{bid:{...input,discount_rate:'0100.1'}},tokens.financer)).status,422);
  assert.equal((await request('POST',`${endpoint}/bid-quote`,{bid:{...input,expires_at:'2020-01-01T12:00:00Z'}},tokens.financer)).status,422);
  const agreement=await request('PATCH',`bids/${bid.data.id}/accept`,{},tokens.buyerAdmin);assert.equal(agreement.status,200);
  const bad=await request('POST',`${endpoint}/agreements`,{agreement_reference:'CALC-REJECT',currency:'GHS',net_disbursement:'999',repayment_amount:'1000',maturity_date:'2030-12-31',document_reference:'evidence://price-mismatch',governing_law:'Ghana',jurisdiction:'Ghana',recourse_type:'non_recourse',idempotency_key:'mismatched-quote-agreement'},tokens.ops);assert.equal(bad.status,422);
});
test('portal supplier approval, invited tender, draft bid privacy and complete financial lifecycle',async()=>{
 await rows("INSERT INTO financier_profiles(user_id,name,country,institution_type) VALUES($1,'Invited institution','GH','bank') ON CONFLICT(user_id) DO NOTHING",[fixture.financer.id]);
 await rows("INSERT INTO financier_profiles(user_id,name,country,institution_type) VALUES($1,'Other institution','GH','bank') ON CONFLICT(user_id) DO NOTHING",[fixture.otherFinancer.id]);
 const foreignLogin=await request('POST','auth/login',{email:fixture.otherAdmin.email,password:'changed-password-123'});const foreignToken=foreignLogin.headers.get('set-cookie')!.match(/invoix_token=([^;]+)/)![1];
 await rows("UPDATE programmes SET status='active',currency='GHS',maximum_tenor_days=3650 WHERE id=$1",[fixture.programme.id]);
 const invoice=await createInvoice('draft');const endpoint=`portal/invoices/${invoice.id}`;
 assert.equal((await request('POST',`${endpoint}/submit`,{},tokens.buyerAdmin)).status,200);
 assert.equal((await request('POST',`${endpoint}/decide`,{decision:'reject'},tokens.supplierUser)).status,422);
 assert.equal((await request('POST',`${endpoint}/decide`,{decision:'approve'},foreignToken)).status,403);
 assert.equal((await request('POST',`${endpoint}/decide`,{decision:'clarify',reason:'Please attach delivery confirmation'},tokens.supplierUser)).status,200);
 assert.equal((await request('POST',`${endpoint}/submit`,{},tokens.buyerAdmin)).status,200);
 assert.equal((await request('POST',`${endpoint}/decide`,{decision:'approve'},tokens.supplierUser)).status,200);
 const tender=await request('POST','portal/tenders',{invoice_id:invoice.id,requested_amount:'1000',closes_on:'2030-12-01',financier_ids:[fixture.financer.id]},tokens.buyerAdmin);assert.equal(tender.status,201,JSON.stringify(tender.data));
 assert.equal((await request('GET',`invoices/${invoice.id}`,undefined,tokens.otherFinancer)).status,403);
 const otherBundle=await request('GET','portal/bootstrap',undefined,tokens.otherFinancer);assert.equal(otherBundle.status,200,JSON.stringify(otherBundle.data));assert.ok(!otherBundle.data.invoices.some((row:any)=>row.id===invoice.id));
 const input={tender_id:tender.data.id,submit:false,bid:{...bidFields,amount:'990',discount_fee:'10',additional_conditions:'Subject to the executed contract'}};
 const draft=await request('POST','portal/bids',input,tokens.financer);assert.equal(draft.status,201,JSON.stringify(draft.data));
 const buyerBundle=await request('GET','portal/bootstrap',undefined,tokens.buyerAdmin);assert.equal(buyerBundle.status,200,JSON.stringify(buyerBundle.data));assert.ok(!buyerBundle.data.bids.some((b:any)=>b.id===draft.data.id));
 assert.equal((await request('PATCH',`bids/${draft.data.id}/accept`,{},tokens.buyerAdmin)).status,409);
 const submitted=await request('POST','portal/bids',{...input,submit:true},tokens.financer);assert.equal(submitted.status,201);assert.equal(submitted.data.id,draft.data.id);assert.equal(submitted.data.net_supplier_proceeds,'980.00');
 assert.equal((await request('PATCH',`bids/${draft.data.id}/accept`,{},tokens.buyerAdmin)).status,200);
 const agreement=await request('POST',`invoices/${invoice.id}/agreements`,{agreement_reference:'PORTAL-AGR',currency:'GHS',net_disbursement:'980',repayment_amount:'1000',maturity_date:'2030-12-31',document_reference:'evidence://portal-signed',governing_law:'Ghana',jurisdiction:'Ghana',recourse_type:'non_recourse',idempotency_key:'portal-agreement'},tokens.ops);assert.equal(agreement.status,201,JSON.stringify(agreement.data));
 assert.equal((await request('POST',`agreements/${agreement.data.id}/sign`,{idempotency_key:'portal-sign-agreement'},tokens.checker)).status,201);
 const proof={payment_reference:'PORTAL-PAYMENT',payment_date:new Date().toISOString().slice(0,10),evidence_reference:'evidence://portal-bank-proof',idempotency_key:'portal-funding'};
 const funding=await request('POST',`invoices/${invoice.id}/fundings`,proof,tokens.ops);assert.equal(funding.status,201,JSON.stringify(funding.data));assert.equal((await request('POST',`fundings/${funding.data.id}/confirm`,{idempotency_key:'portal-confirm-funding'},tokens.checker)).status,201);
 const receipt=await request('POST',`invoices/${invoice.id}/repayments`,{...proof,payment_reference:'PORTAL-RECEIPT',idempotency_key:'portal-receipt',amount:'1000',currency:'GHS'},tokens.buyerAdmin);assert.equal(receipt.status,201,JSON.stringify(receipt.data));assert.equal((await request('POST',`repayments/${receipt.data.id}/confirm`,{idempotency_key:'portal-confirm-receipt'},tokens.checker)).status,201);
 const bundle=await request('GET','portal/bootstrap',undefined,tokens.financer);assert.equal(bundle.status,200,JSON.stringify(bundle.data));assert.ok(bundle.data.bids.every((bid:any)=>bid.financer_id===fixture.financer.id));assert.equal(bundle.data.positions.find((p:any)=>p.invoice_id===invoice.id).outstanding_amount,'0.00');
 assert.equal(JSON.stringify(bundle.data).includes('encrypted_password'),false);assert.equal(JSON.stringify(bundle.data).includes('mfa_secret_encrypted'),false);
 assert.equal((await request('POST','portal/verification/buyer-1',{status:'APPROVED'},tokens.buyerAdmin)).status,403);
 assert.equal((await request('POST','portal/configuration',{key:'permissions',value:{}},tokens.financer)).status,403);
 const config=await request('POST','portal/configuration',{key:'fees',value:{rate:'2.5'}},tokens.ops);assert.equal(config.status,200);assert.equal((await request('GET','portal/configuration',undefined,tokens.ops)).data.find((r:any)=>r.key==='fees').value.rate,'2.5');
});
test('portal registration, email verification, onboarding and independently audited review',async()=>{
 const signup=await request('POST','portal-auth/register',{name:'New company admin',email:'portal-register@example.test',password:'Portal-password-123'});assert.equal(signup.status,201,JSON.stringify(signup.data));const token=signup.headers.get('set-cookie')!.match(/invoix_token=([^;]+)/)![1];
 const sent=await request('POST','portal-auth/email-send',{},token);assert.equal(sent.status,200,JSON.stringify(sent.data));const code=new URL(sent.data.preview_url).searchParams.get('code');assert.ok(code);
 assert.equal((await request('POST','portal-auth/email-verify',{code:'000000'},token)).status,422);
 assert.equal((await request('POST','portal-auth/email-verify',{code},token)).status,200);
 const user=(await request('GET','auth/me',undefined,token)).data.user;
 const documents=await rows("INSERT INTO documents(category,file_name,mime_type,size_bytes,storage_key,sha256,uploaded_by,upload_status,created_by) SELECT 'incorporation','corporate.pdf','application/pdf',100,'private-test-'||generate_series,repeat('a',64),$1,'stored',$1 FROM generate_series(1,3) RETURNING id",[user.id]);
 const application={type:'BUYER',company:{name:'Portal registered company',registrationNumber:'PORTAL-REG',country:'Ghana',address:'Registered company address',email:'portal-register@example.test',phone:'+233200000001',industry:'Manufacturing'},representative:{fullName:'New company admin',jobTitle:'Finance manager',email:'portal-register@example.test',phone:'+233200000001',authorised:true},document_ids:documents.map(d=>d.id),confirmed:true};
 const onboard=await request('POST','portal-auth/onboarding',application,token);assert.equal(onboard.status,200,JSON.stringify(onboard.data));
 const review=await request('POST',`portal/verification/${onboard.data.org_ref}`,{status:'INFO_REQUIRED',note:'Provide the current tax certificate'},tokens.ops);assert.equal(review.status,200,JSON.stringify(review.data));
 const status=await request('GET','portal-auth/onboarding',undefined,token);assert.equal(status.data.review.note,'Provide the current tax certificate');
 assert.equal((await request('POST','portal-auth/onboarding',application,token)).status,200);
 assert.equal((await request('POST',`portal/verification/${onboard.data.org_ref}`,{status:'APPROVED'},tokens.checker)).status,409);
 for(const doc of documents)assert.equal((await request('POST',`portal/document-reviews/${doc.id}`,{decision:'verify'},tokens.ops)).status,200);
 assert.equal((await request('POST',`portal/verification/${onboard.data.org_ref}`,{status:'APPROVED'},tokens.checker)).status,200);
 assert.equal((await request('GET','portal-auth/onboarding',undefined,token)).data.review.status,'APPROVED');
 const events=await rows("SELECT * FROM portal_events WHERE event='organization.reviewed'");assert.ok(events.some(e=>e.reason==='Provide the current tax certificate'));
 await assert.rejects(rows('DELETE FROM portal_events'),/append-only/);
});
test('private document storage requires authentication and refuses unrelated downloads',async()=>{
 const data=new FormData();data.set('file',new File([new TextEncoder().encode('%PDF-1.4\nprivate evidence')],'evidence.pdf',{type:'application/pdf'}));
 const req=new NextRequest('http://localhost:3000/api/portal/documents',{method:'POST',headers:{cookie:`invoix_token=${tokens.buyerAdmin}`},body:data});
 const uploaded=await uploadDocument(req);assert.equal(uploaded.status,201);const doc=await uploaded.json();
 const denied=await downloadDocument(new NextRequest(`http://localhost:3000/api/portal/documents/${doc.id}`,{headers:{cookie:`invoix_token=${tokens.financer}`}}),{params:Promise.resolve({id:doc.id})});assert.equal(denied.status,404);
 const own=await downloadDocument(new NextRequest(`http://localhost:3000/api/portal/documents/${doc.id}`,{headers:{cookie:`invoix_token=${tokens.buyerAdmin}`}}),{params:Promise.resolve({id:doc.id})});assert.equal(own.status,200);assert.match(own.headers.get('content-disposition')!,/^attachment/);assert.equal(own.headers.get('x-content-type-options'),'nosniff');
 const bad=new FormData();bad.set('file',new File(['<script>alert(1)</script>'],'bad.pdf',{type:'application/pdf'}));assert.equal((await uploadDocument(new NextRequest('http://localhost:3000/api/portal/documents',{method:'POST',headers:{cookie:`invoix_token=${tokens.buyerAdmin}`},body:bad}))).status,422);
});
test('authenticator enrolment requires a password and login consumes a real one-time challenge',async()=>{
 assert.equal((await request('POST','portal-auth/mfa-setup',{password:'incorrect'},tokens.checker)).status,403);
 const setup=await request('POST','portal-auth/mfa-setup',{password:'legacy-secret'},tokens.checker);assert.equal(setup.status,200,JSON.stringify(setup.data));
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits='';for(const char of setup.data.secret)bits+=alphabet.indexOf(char).toString(2).padStart(5,'0');const secret=Buffer.from(bits.match(/.{8}/g)!.map(byte=>parseInt(byte,2)));const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));const hash=createHmac('sha1',secret).update(counter).digest();const offset=hash[19]&15;const code=String((hash.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
 assert.equal((await request('POST','portal-auth/mfa-enrol',{code},tokens.checker)).status,200);
 const login=await request('POST','auth/login',{email:fixture.checker.email,password:'legacy-secret'});assert.equal(login.data.mfa_required,true);assert.equal(login.data.user,undefined);const challenge=login.headers.get('set-cookie')!.match(/invox_mfa_challenge=([^;]+)/)![1];
 const verifyWith=(value:string)=>handleRequest(new NextRequest('http://localhost:3000/api/portal-auth/mfa-verify',{method:'POST',headers:{cookie:`invox_mfa_challenge=${challenge}`,'Content-Type':'application/json'},body:JSON.stringify({code:value})}),['portal-auth','mfa-verify']);
 assert.equal((await verifyWith(code)).status,422);
 const next=totp(secret,1);const result=await verifyWith(next);assert.equal(result.status,200);
 const repeat=await verifyWith(next);assert.equal(repeat.status,422);
});
test('portal currencies NGN and KES persist without currency conversion',async()=>{
 for(const currency of ['NGN','KES']){const invoice=await request('POST','invoices',{invoice:{...invoiceFields(),programme_id:fixture.programme.id,supplier_id:fixture.supplier.id,amount:'1000.25',currency,status:'draft'}},tokens.ops);assert.equal(invoice.status,201,JSON.stringify(invoice.data));assert.equal(invoice.data.currency,currency);}
});
test('review reasons are visible to operations and the applicant, not transaction counterparties',async()=>{
 const reference=`supplier-${fixture.supplier.id}`;
 await rows("INSERT INTO portal_org_reviews(org_ref,status,note,submitted_by) VALUES($1,'INFO_REQUIRED','Private applicant verification request',$2)",[reference,fixture.supplierUser.id]);
 const buyer=await request('GET','portal/bootstrap',undefined,tokens.buyerAdmin);assert.equal(buyer.status,200,JSON.stringify(buyer.data));assert.equal(buyer.data.reviews.find((r:any)=>r.org_ref===reference).note,null);
 const supplier=await request('GET','portal/bootstrap',undefined,tokens.supplierUser);assert.equal(supplier.status,200);assert.equal(supplier.data.reviews.find((r:any)=>r.org_ref===reference).note,'Private applicant verification request');
});
test('password recovery rotates credentials, revokes sessions, and consumes tokens',async()=>{
  const issued=await request('POST','auth/forgot-password',{email:fixture.financer.email});
  assert.equal(issued.status,200);const token=new URL(issued.data.preview_url).searchParams.get('token');
  const reset=await request('POST','auth/reset-password',{token,password:'reset-password-123'});assert.equal(reset.status,200,JSON.stringify(reset.data));
  assert.equal((await request('GET','auth/me',undefined,tokens.financer)).data.user,null);
  assert.equal((await request('POST','auth/reset-password',{token,password:'reset-password-456'})).status,422);
  assert.equal((await request('POST','auth/login',{email:fixture.financer.email,password:'reset-password-123'})).status,200);
});
test('expired and logged-out sessions are unusable; login throttling persists',async()=>{
  const token=await login('supplierUser');await rows("UPDATE app_sessions SET expires_at=now()-interval '1 minute' WHERE token_hash=$1",[digest(token)]);
  assert.equal((await request('GET','auth/me',undefined,token)).data.user,null);
  const live=await login('supplierUser');assert.equal((await request('POST','auth/logout',undefined,live)).status,200);
  assert.equal((await request('GET','auth/me',undefined,live)).data.user,null);
  for(let attempt=0;attempt<10;attempt++) assert.equal((await request('POST','auth/login',{email:'missing@example.test',password:'wrong-password'})).status,401);
  assert.equal((await request('POST','auth/login',{email:'missing@example.test',password:'wrong-password'})).status,429);
});
test('operations review uploaded evidence with an independent reviewer and a required rejection reason',async()=>{
  const upload=async()=>{const form=new FormData();form.set('file',new File(['%PDF-1.4 review'],'review.pdf',{type:'application/pdf'}));form.set('category','incorporation');const res=await uploadDocument(new NextRequest('http://localhost:3000/api/portal/documents',{method:'POST',headers:{cookie:`invoix_token=${tokens.buyerAdmin}`},body:form}));assert.equal(res.status,201);return (await res.json()).id;};
  const first=await upload();const second=await upload();
  assert.equal((await request('POST',`portal/document-reviews/${first}`,{decision:'verify'},tokens.buyerAdmin)).status,403);
  assert.equal((await request('POST',`portal/document-reviews/${first}`,{decision:'reject',reason:'short'},tokens.ops)).status,422);
  const rejected=await request('POST',`portal/document-reviews/${first}`,{decision:'reject',reason:'Registration number is not legible'},tokens.ops);
  assert.equal(rejected.status,200,JSON.stringify(rejected.data));assert.equal(rejected.data.review_status,'rejected');assert.equal(rejected.data.verified_at,null);
  assert.equal((await request('POST',`portal/document-reviews/${first}`,{decision:'verify'},tokens.checker)).status,409);
  const verified=await request('POST',`portal/document-reviews/${second}`,{decision:'verify'},tokens.checker);
  assert.equal(verified.data.review_status,'verified');assert.ok(verified.data.verified_at);
  const [event]=await rows("SELECT reason FROM portal_events WHERE event='document.rejected' AND details->>'document_id'=$1",[String(first)]);
  assert.equal(event.reason,'Registration number is not legible');
  const [note]=await rows("SELECT subject FROM notifications WHERE user_id=$1 AND subject='Document rejected'",[fixture.buyerAdmin.id]);assert.ok(note);
  const boot=await request('GET','portal/bootstrap',undefined,tokens.buyerAdmin);
  assert.equal(boot.data.documents.find((d:any)=>String(d.id)===String(first)).review_reason,'Registration number is not legible');
});
test('change password verifies the current password, revokes other sessions and issues a new one',async()=>{
  const hash=await bcrypt.hash('legacy-secret',4);const user=await transaction(db=>insert('users',{email:`changer-${randomUUID()}@example.test`,encrypted_password:hash,role:2,jti:randomUUID()},db));
  const signIn=async(password:string)=>request('POST','auth/login',{email:user.email,password});
  const old=(await signIn('legacy-secret')).headers.get('set-cookie')!.match(/invoix_token=([^;]+)/)![1];
  assert.equal((await request('POST','auth/change-password',{current_password:'wrong-password',password:'Fresh-password-2026!',password_confirmation:'Fresh-password-2026!'},old)).status,422);
  assert.equal((await request('POST','auth/change-password',{current_password:'legacy-secret',password:'Fresh-password-2026!',password_confirmation:'mismatch'},old)).status,422);
  assert.equal((await request('POST','auth/change-password',{current_password:'legacy-secret',password:'Fresh-password-2026!',password_confirmation:'Fresh-password-2026!'})).status,401);
  const changed=await request('POST','auth/change-password',{current_password:'legacy-secret',password:'Fresh-password-2026!',password_confirmation:'Fresh-password-2026!'},old);
  assert.equal(changed.status,200,JSON.stringify(changed.data));
  const fresh=changed.headers.get('set-cookie')!.match(/invoix_token=([^;]+)/)![1];
  assert.equal((await request('GET','auth/me',undefined,old)).data.user,null);
  assert.equal((await request('GET','auth/me',undefined,fresh)).data.user.id,String(user.id));
  assert.equal((await signIn('legacy-secret')).status,401);
  assert.equal((await signIn('Fresh-password-2026!')).status,200);
});
test('portal invoice form payload creates, edits, deletes and submits drafts with duplicate protection',async()=>{
  const reason={reason:'Reviewed commercial configuration'};
  await rows("INSERT INTO financier_profiles(user_id,name,country,institution_type) VALUES($1,'Form test institution','GH','bank') ON CONFLICT(user_id) DO NOTHING",[fixture.financer.id]);
  const programme=await request('POST','portal/manage/programmes',{name:'Form programme',buyer_id:fixture.buyer.id,limit:'50000.00',fee_percent:'1',maturity_days:3650,currency:'GHS',programme_reference:`FORM-${randomUUID().slice(0,6)}`,governing_law:'Ghana',jurisdiction:'Accra',buyer_acceptance_authority:'buyer',allocation_policy:'deterministic',supplier_ids:[fixture.supplier.id],financier_ids:[fixture.financer.id]},tokens.ops);
  assert.equal(programme.status,201,JSON.stringify(programme.data));const programmeId=programme.data.id;
  const released=await request('POST',`portal/manage/programmes/${programmeId}/submit`,reason,tokens.buyerAdmin);assert.equal(released.status,200,JSON.stringify(released.data));
  // Separation of duties (NC-05): the operator who configured the programme cannot release it.
  assert.equal((await request('POST',`portal/manage/programmes/${programmeId}/activate`,reason,tokens.ops)).status,409);
  const active=await request('POST',`portal/manage/programmes/${programmeId}/activate`,reason,tokens.checker);assert.equal(active.status,200,JSON.stringify(active.data));
  // Exactly what the buyer's guided invoice form sends (frontend service invoicePayload).
  const form=(number:string,overrides:Record<string,unknown>={})=>({programme_id:String(programmeId),supplier_id:String(fixture.supplier.id),invoice_number:number,purchase_order_reference:null,description:'Delivered goods to warehouse',amount:'2500.50',currency:'GHS',issue_date:'2026-01-01',due_date:'2030-06-30',payment_terms:'Net 1641 days',financing_eligible:true,supporting_documents:[],...overrides});
  const draft=await request('POST','portal/manage/invoices',form('FORM-001',{amount:null,description:null,due_date:null,payment_terms:null}),tokens.buyerAdmin);
  assert.equal(draft.status,201,JSON.stringify(draft.data));assert.equal(draft.data._actions.edit,true);assert.equal(draft.data._actions.delete,true);
  const edited=await request('PATCH',`portal/manage/invoices/${draft.data.id}`,form('FORM-001',{purchase_order_reference:'PO-77'}),tokens.buyerAdmin);
  assert.equal(edited.status,200,JSON.stringify(edited.data));assert.equal(edited.data.amount,'2500.50');assert.equal(edited.data.purchase_order_reference,'PO-77');
  assert.equal((await request('POST','portal/manage/invoices',form('FORM-001'),tokens.buyerAdmin)).status,409);
  // Suppliers confirm invoices; they cannot change the buyer's terms.
  const supplierToken=(await request('POST','auth/login',{email:fixture.supplierUser.email,password:'legacy-secret'})).headers.get('set-cookie')?.match(/invoix_token=([^;]+)/)?.[1];
  const supplierEdit=await request('PATCH',`portal/manage/invoices/${draft.data.id}`,form('FORM-001',{amount:'1'}),supplierToken);
  assert.ok([403,409].includes(supplierEdit.status),JSON.stringify(supplierEdit));
  const second=await request('POST','portal/manage/invoices',form('FORM-002'),tokens.buyerAdmin);assert.equal(second.status,201);
  assert.equal((await request('DELETE',`portal/manage/invoices/${second.data.id}`,undefined,tokens.buyerAdmin)).status,204);
  // Soft delete: kept for audit and restore, hidden from the buyer's invoice list.
  const removed=(await request('GET',`portal/manage/invoices/${second.data.id}`,undefined,tokens.buyerAdmin)).data;assert.ok(removed.deleted_at);assert.equal(removed._actions.restore,true);
  assert.equal((await request('GET','portal/bootstrap',undefined,tokens.buyerAdmin)).data.invoices.some((r:any)=>String(r.id)===String(second.data.id)),false);
  const submitted=await request('POST',`portal/invoices/${draft.data.id}/submit`,{},tokens.buyerAdmin);assert.equal(submitted.status,200,JSON.stringify(submitted.data));
  const locked=await request('GET',`portal/manage/invoices/${draft.data.id}`,undefined,tokens.buyerAdmin);
  assert.equal(locked.data._actions.edit,false);assert.equal(locked.data._actions.delete,false);
  assert.equal((await request('DELETE',`portal/manage/invoices/${draft.data.id}`,undefined,tokens.buyerAdmin)).status,409);
});
