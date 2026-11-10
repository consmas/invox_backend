// Run against both local apps and a disposable database, never a live deployment.
import assert from 'node:assert/strict';
const origin=process.env.SMOKE_FRONTEND_URL;
assert.ok(origin&&['localhost','127.0.0.1'].includes(new URL(origin).hostname),'Set a local SMOKE_FRONTEND_URL');
assert.ok(process.env.SMOKE_EMAIL&&process.env.SMOKE_PASSWORD,'Set disposable operator credentials in SMOKE_EMAIL/SMOKE_PASSWORD');
const checks=[];
async function request(method,path,body,cookie,expected=200){
  const response=await fetch(`${origin}${path}`,{method,redirect:'manual',headers:{origin,...(body?{'Content-Type':'application/json'}:{}),...(cookie?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const text=await response.text();
  assert.equal(response.status,expected,`${method} ${path}: ${text.slice(0,300)}`);
  checks.push(`${method} ${path}: ${response.status}`);
  return {data:response.headers.get('content-type')?.includes('json')&&text?JSON.parse(text):text,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
const stamp=Date.now();
const invoiceFields={invoice_number:`HTTP-INVOICE-${stamp}`,currency:'GHS',issue_date:'2026-01-01',due_date:'2030-12-31',description:'HTTP goods invoice',payment_terms:'Net 30',financing_eligible:true};
await request('GET','/api/health');
await request('GET','/',undefined,undefined,200);
const operator=await request('POST','/api/auth/login',{email:process.env.SMOKE_EMAIL,password:process.env.SMOKE_PASSWORD});
assert.ok(operator.cookie);
await request('GET','/api/auth/me',undefined,operator.cookie);
await request('GET','/api/v1/users',undefined,operator.cookie);
const buyer=(await request('POST','/api/buyers',{buyer:{name:`HTTP buyer ${stamp}`,registration_number:`HTTP-${stamp}`,country:'GH',contact_email:`buyer-${stamp}@example.test`,users:[{email:`buyer-${stamp}@example.test`,password:'http-password-123',role:'buyer_admin'}]}},operator.cookie,201)).data;
const programme=(await request('POST',`/api/buyers/${buyer.id}/programmes`,{programme:{name:'HTTP programme',programme_reference:`HTTP-PRG-${stamp}`,currency:'GHS',governing_law:'Ghana',jurisdiction:'Ghana',limit:'100000',fee_percent:2,maturity_days:30}},operator.cookie,201)).data;
const supplier=(await request('POST','/api/suppliers',{supplier:{name:'HTTP supplier',country:'GH',contact_email:`supplier-${stamp}@example.test`,invite:'create',password:'http-password-123'}},operator.cookie,201)).data;
const invoice=(await request('POST',`/api/buyers/${buyer.id}/invoices`,{invoice:{...invoiceFields,programme_id:programme.id,supplier_id:supplier.id,amount:'1000.50',status:'tender'}},operator.cookie,201)).data;
const financer=(await request('POST','/api/financers',{financer:{name:'HTTP lender',registration_number:`LENDER-${stamp}`,institution_type:'bank',country:'GH',contact_email:`finance-office-${stamp}@example.test`,email:`financer-${stamp}@example.test`,password:'http-password-123'}},operator.cookie,201)).data;
const financeSession=await request('POST','/api/auth/login',{email:financer.email,password:'http-password-123'});
const bid=(await request('POST',`/api/invoices/${invoice.id}/bids`,{bid:{amount:'950.25',currency:'GHS',discount_type:'fixed',discount_fee:'0',expiry_date:'2030-12-01'}},financeSession.cookie,201)).data;
await request('PATCH',`/api/buyers/${buyer.id}/invoices/${invoice.id}/bids/${bid.id}/accept`,{},operator.cookie);
const before=(await request('GET',`/api/invoices/${invoice.id}`,undefined,operator.cookie)).data;
assert.equal(before.status,'tender');
const checker=(await request('POST','/api/users',{user:{email:`checker-${stamp}@example.test`,password:'http-checker-123',role:'platform_ops'}},operator.cookie,201)).data;
const checkerSession=await request('POST','/api/auth/login',{email:checker.email,password:'http-checker-123'});
const agreement=(await request('POST',`/api/invoices/${invoice.id}/agreements`,{agreement_reference:`HTTP-AGR-${stamp}`,governing_law:'Ghana',jurisdiction:'Ghana',recourse_type:'non_recourse',currency:'GHS',net_disbursement:'950.25',repayment_amount:'1000.50',maturity_date:'2030-12-31',document_reference:'evidence://executed-http-agreement',idempotency_key:`http-agreement-${stamp}`},operator.cookie,201)).data;
await request('POST',`/api/agreements/${agreement.id}/sign`,{idempotency_key:`http-sign-${stamp}`},checkerSession.cookie,201);
const proof={payment_reference:`BANK-FUNDING-${stamp}`,payment_date:new Date().toISOString().slice(0,10),evidence_reference:'evidence://bank-disbursement-confirmation',idempotency_key:`http-funding-${stamp}`};
const funding=(await request('POST',`/api/invoices/${invoice.id}/fundings`,proof,operator.cookie,201)).data;
await request('POST',`/api/fundings/${funding.id}/confirm`,{idempotency_key:`http-confirm-${stamp}`},checkerSession.cookie,201);
const receipt=(await request('POST',`/api/invoices/${invoice.id}/repayments`,{...proof,amount:'1000.50',currency:'GHS',payment_reference:`BANK-RECEIPT-${stamp}`,idempotency_key:`http-receipt-${stamp}`},operator.cookie,201)).data;
await request('POST',`/api/repayments/${receipt.id}/confirm`,{idempotency_key:`http-settle-${stamp}`},checkerSession.cookie,201);
assert.equal((await request('GET',`/api/invoices/${invoice.id}/financials`,undefined,operator.cookie)).data.position.outstanding_amount,'0.00');
const portfolio=(await request('GET',`/api/financers/${financer.id}/portfolio`,undefined,financeSession.cookie)).data;
assert.ok(portfolio.some(record=>String(record.id)===String(invoice.id)));
for(const path of ['/',`/buyers/${buyer.id}`,`/buyers/${buyer.id}/programmes`,`/buyers/${buyer.id}/invoices`,`/buyers/${buyer.id}/invoices/${invoice.id}`,`/buyers/${buyer.id}/invoices/${invoice.id}/edit`,`/buyers/${buyer.id}/invoices/new`,'/admin/records','/admin/records/documents','/admin/records/documents/new','/admin/records/mandate_versions/new','/financers/new',`/financers/${financer.id}/edit`,'/suppliers','/users','/profile']){
 await request('GET',path,undefined,operator.cookie);
}
for(const section of ['', '/opportunities','/bids','/portfolio'])await request('GET',`/financers/${financer.id}${section}`,undefined,financeSession.cookie);
for(const path of ['/invoices',`/invoices/${invoice.id}`,`/bids/${bid.id}`])await request('GET',path,undefined,financeSession.cookie);

const buyerSession=await request('POST','/api/auth/login',{email:`buyer-${stamp}@example.test`,password:'http-password-123'});
const supplierSession=await request('POST','/api/auth/login',{email:`supplier-${stamp}@example.test`,password:'http-password-123'});
const roles={admin:operator.cookie,buyer:buyerSession.cookie,supplier:supplierSession.cookie,financier:financeSession.cookie};
const sections={admin:['','/organizations','/verification','/operations','/repayments','/audit-log','/platform-settings','/settings','/notifications','/help'],buyer:['','/invoices','/invoices/new','/programmes','/suppliers','/tenders','/repayments','/settings','/notifications','/help'],supplier:['','/approvals','/invoices','/early-payment','/payments','/reports','/settings','/notifications','/help'],financier:['','/marketplace','/bids','/portfolio','/repayments','/analytics','/settings','/notifications','/help']};
for(const [role,cookie] of Object.entries(roles)){
 for(const suffix of sections[role])await request('GET',`/${role}${suffix}`,undefined,cookie);
 for(const other of Object.keys(roles).filter(other=>other!==role))await request('GET',`/${other}`,undefined,cookie,404);
 const bootstrap=(await request('GET','/api/portal/bootstrap',undefined,cookie)).data;
 assert.ok(!JSON.stringify(bootstrap).includes('encrypted_password'));assert.ok(!JSON.stringify(bootstrap).includes('mfa_secret_encrypted'));
 if(role==='financier')assert.ok(bootstrap.bids.every(record=>String(record.financer_id)===String(financer.id)));
}
for(const page of ['/how-it-works','/for-buyers','/for-suppliers','/for-financiers','/about','/contact','/calculator','/privacy','/terms','/login','/register','/mfa','/verify-email','/invite','/complete-profile','/forgot-password','/reset-password'])await request('GET',page);
await request('GET','/console',undefined,operator.cookie);
await request('GET',`/buyer/invoices/${invoice.id}`,undefined,buyerSession.cookie);
await request('GET',`/supplier/invoices/${invoice.id}`,undefined,supplierSession.cookie);
const draft=(await request('POST','/api/invoices',{invoice:{...invoiceFields,programme_id:programme.id,supplier_id:supplier.id,amount:'10',invoice_number:`HTTP-DRAFT-${stamp}`,status:'draft'}},operator.cookie,201)).data;
const deleted=await request('DELETE',`/api/invoices/${draft.id}`,undefined,operator.cookie,204);assert.equal(deleted.data,'');
await request('POST','/api/auth/logout',{},financeSession.cookie);
await request('GET','/api/invoices',undefined,financeSession.cookie,401);
console.log(checks.join('\n'));
console.log(`Passed ${checks.length} live HTTP checks across frontend and nbackend.`);
