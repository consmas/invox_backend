import { z } from 'zod';
import { type Actor,requireRole,digest } from './auth';
import { preparedOnBehalfBy } from './act-for';
import { rows,transaction,type DB,type Row } from './db';
import { requireCondition,ApiError } from './errors';
import { id,date } from './validation';
import { cents,decimal } from './money';
import { audit } from './audit';
import { fieldSchema,rejectManagedFields,databaseValues,validateFieldReferences } from './fields';

const positiveMoney=z.string().max(22).refine(value=>{try{return cents(value)>BigInt(0);}catch{return false;}},'Use a positive decimal amount').transform(value=>decimal(cents(value)));
const currency=z.enum(['GHS','USD','EUR','NGN','KES']);
const evidence=z.string().trim().min(5).max(2000);
const pastDate=date.refine(value=>value<=new Date().toISOString().slice(0,10),'Payment date cannot be in the future');
const agreementInput=z.object({currency,net_disbursement:positiveMoney,repayment_amount:positiveMoney,maturity_date:date,document_reference:evidence});
const paymentInput=z.object({payment_reference:z.string().trim().min(3).max(200),evidence_reference:evidence,payment_date:pastDate});
const receiptInput=paymentInput.extend({amount:positiveMoney,currency});
const reversalInput=paymentInput.extend({reason:z.string().trim().min(10).max(2000)});
const same=(left:unknown,right:unknown)=>String(left)===String(right);
export function assertFinancialRelease() {
  requireCondition(process.env.NODE_ENV!=='production',503,'Financial execution is blocked pending production onboarding, MFA, tenancy and allocation controls');
}
function stable(value:unknown):unknown {
  if(Array.isArray(value))return value.map(stable);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='idempotency_key').sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,stable(item)]));
  return value;
}
async function invoiceContext(actor:Actor,invoiceId:string,db:DB,write:boolean):Promise<Row> {
  const [invoice]=await rows(`SELECT i.*,p.buyer_id,s.user_id AS supplier_user_id,d.id AS accepted_bid_id,d.financer_id,d.amount AS offered_amount,d.net_supplier_proceeds AS quoted_net,d.discount_fee AS quoted_discount,d.other_fees AS quoted_fees
    FROM invoices i JOIN programmes p ON p.id=i.programme_id JOIN suppliers s ON s.id=i.supplier_id
    LEFT JOIN bids d ON d.invoice_id=i.id AND d.status=1 WHERE i.id=$1 ${write?'FOR UPDATE OF i':'FOR SHARE OF i'}`,[invoiceId],db);
  requireCondition(invoice,404,'Invoice not found');
  const authorized=actor.role==='platform_ops'||actor.role==='buyer_admin'&&same(actor.buyer_id,invoice.buyer_id)
    ||actor.role==='supplier_user'&&same(actor.id,invoice.supplier_user_id)||actor.role==='financer'&&same(actor.id,invoice.financer_id);
  requireCondition(authorized,404,'Invoice not found');
  return invoice;
}
async function financialSnapshot(invoice:Row,db:DB) {
  const agreements=await rows('SELECT * FROM financing_agreements WHERE invoice_id=$1 ORDER BY id',[invoice.id],db);
  const agreement=agreements.find(record=>record.status!=='rejected')??null;
  const fundings=await rows('SELECT * FROM fundings WHERE invoice_id=$1 ORDER BY id',[invoice.id],db);
  const repayments=await rows('SELECT * FROM repayments WHERE invoice_id=$1 ORDER BY id',[invoice.id],db);
  const position=(await rows('SELECT * FROM financial_positions WHERE invoice_id=$1',[invoice.id],db))[0]??null;
  const events=await rows(`SELECT e.id,e.event,e.record_type,e.record_id,e.actor_id,e.created_at,e.details FROM audit_events e WHERE invoice_id=$1 ORDER BY e.id DESC LIMIT 100`,[invoice.id],db);
  return {invoice_id:invoice.id,invoice_status:invoice.status,accepted_bid_id:invoice.accepted_bid_id,financer_id:invoice.financer_id,
    financial_review_required:invoice.financial_review_required,accepted_offer:invoice.accepted_bid_id?{amount:invoice.offered_amount,currency:invoice.currency,net_supplier_proceeds:invoice.quoted_net,discount_fee:invoice.quoted_discount,other_fees:invoice.quoted_fees}:null,agreement,agreements,fundings,repayments,position,events,
    execution_enabled:process.env.NODE_ENV!=='production',mode:'manual_evidence',bank_connected:false};
}
async function journal(db:DB,invoiceId:string,type:'funding'|'receipt'|'reversal',sourceId:string,money:string,unit:string) {
  const [record]=await rows(`INSERT INTO ledger_journals(invoice_id,source_type,source_id,currency) VALUES($1,$2,$3,$4) RETURNING id`,[invoiceId,type,sourceId,unit],db);
  const first=type==='receipt'?'funder_entitlement':'buyer_obligation';
  const second=type==='receipt'?'buyer_obligation':'funder_entitlement';
  await rows(`INSERT INTO ledger_lines(journal_id,account_code,side,amount) VALUES($1,$2,'debit',$4),($1,$3,'credit',$4)`,[record.id,first,second,money],db);
}
async function insertFinancial(table:'financing_agreements'|'fundings'|'repayments',data:Record<string,unknown>,db:DB){
  const keys=Object.keys(data);return rows(`INSERT INTO ${table} (${keys.map(key=>'"'+key+'"').join(',')}) VALUES(${keys.map((_,index)=>'$'+(index+1)).join(',')}) RETURNING *`,Object.values(data),db);
}
async function proposeAgreement(actor:Actor,invoice:Row,body:Record<string,unknown>,db:DB) {
  requireRole(actor,'platform_ops');
  requireCondition(invoice.status==='tender'&&invoice.accepted_bid_id,409,'An accepted offer on a tendered invoice is required');
  rejectManagedFields('agreements',body);
  const data={...fieldSchema('agreements',false,{exclude:Object.keys(agreementInput.shape)}).parse(body),...agreementInput.parse(body)};
  await validateFieldReferences('agreements',data,actor,db);
  requireCondition(invoice.currency===data.currency,422,'Agreement currency must match the invoice');
  requireCondition(cents(data.net_disbursement)<=cents(invoice.offered_amount),422,'Disbursement exceeds the accepted offer');
  if(invoice.quoted_net)requireCondition(cents(data.net_disbursement)===cents(invoice.quoted_net),422,'Net disbursement must equal the accepted offer’s calculated supplier proceeds');
  requireCondition(cents(data.repayment_amount)>=cents(data.net_disbursement),422,'Contractual repayment cannot be below the net disbursement');
  requireCondition(data.maturity_date>=new Date().toISOString().slice(0,10),422,'Maturity must be today or later');
  const values={...databaseValues('agreements',data),invoice_id:invoice.id,bid_id:invoice.accepted_bid_id,proposed_by:actor.id};
  const [agreement]=await insertFinancial('financing_agreements',values,db);
  await audit(db,actor,String(invoice.id),'agreement.proposed','agreement',String(agreement.id),{after:agreement});
  return agreement;
}
async function signAgreement(actor:Actor,invoice:Row,recordId:string,db:DB,action='sign') {
  requireRole(actor,'platform_ops');
  const [agreement]=await rows('SELECT * FROM financing_agreements WHERE id=$1 AND invoice_id=$2 FOR UPDATE',[recordId,invoice.id],db);
  requireCondition(agreement,404,'Agreement not found');
  requireCondition(agreement.status==='proposed',409,'Agreement is already signed');
  requireCondition(!same(actor.id,agreement.proposed_by),403,'A different operator must verify the executed agreement');
  requireCondition(invoice.status==='tender'&&same(invoice.accepted_bid_id,agreement.bid_id),409,'The accepted offer has changed');
  const [signed]=action==='sign'
    ?await rows(`UPDATE financing_agreements SET status='signed',signed_by=$2,signed_at=now(),updated_at=now() WHERE id=$1 RETURNING *`,[recordId,actor.id],db)
    :await rows("UPDATE financing_agreements SET status='rejected',updated_at=now() WHERE id=$1 RETURNING *",[recordId],db);
  await audit(db,actor,String(invoice.id),action==='sign'?'agreement.execution_verified':'agreement.rejected','agreement',recordId,{before:agreement,after:signed});
  return signed;
}
async function recordFunding(actor:Actor,invoice:Row,body:Record<string,unknown>,db:DB) {
  requireCondition(actor.role==='platform_ops'||actor.role==='financer'&&same(actor.id,invoice.financer_id),403,'Only operations or the selected financer may record disbursement evidence');
  rejectManagedFields('fundings',body);
  const data={...fieldSchema('fundings',false,{exclude:Object.keys(paymentInput.shape)}).parse(body),...paymentInput.parse(body)};
  const [agreement]=await rows("SELECT * FROM financing_agreements WHERE invoice_id=$1 AND status='signed'",[invoice.id],db);
  requireCondition(agreement&&invoice.status==='tender',409,'A verified executed agreement is required before recording disbursement');
  requireCondition(same(agreement.bid_id,invoice.accepted_bid_id),409,'The accepted offer no longer matches the agreement');
  const values={...databaseValues('fundings',data),agreement_id:agreement.id,invoice_id:invoice.id,amount:agreement.net_disbursement,currency:agreement.currency,recorded_by:actor.id,gross_invoice_amount:invoice.amount,financed_amount:invoice.offered_amount,discount_amount:invoice.quoted_discount??null,other_charges:invoice.quoted_fees??null};
  const [funding]=await insertFinancial('fundings',values,db);
  await audit(db,actor,String(invoice.id),'funding.evidence_recorded','funding',String(funding.id),{after:funding});
  return funding;
}
async function decideFunding(actor:Actor,invoice:Row,recordId:string,action:string,db:DB) {
  requireRole(actor,'platform_ops');
  const [funding]=await rows('SELECT * FROM fundings WHERE id=$1 AND invoice_id=$2 FOR UPDATE',[recordId,invoice.id],db);
  requireCondition(funding,404,'Funding record not found');
  requireCondition(funding.status==='pending',409,'Funding evidence has already been decided');
  requireCondition(!same(actor.id,funding.recorded_by)&&!await preparedOnBehalfBy(actor.id,'funding',recordId,db),403,'The recorder cannot verify or reject their own payment evidence');
  const [agreement]=await rows('SELECT * FROM financing_agreements WHERE id=$1',[funding.agreement_id],db);
  if(action==='confirm') {
    requireCondition(invoice.status==='tender'&&agreement.status==='signed',409,'Funding prerequisites no longer hold');
    requireCondition(agreement.maturity_date>=funding.payment_date,422,'Disbursement cannot occur after contractual maturity');
    await rows("UPDATE fundings SET status='completed',confirmed_by=$2,confirmed_at=now(),updated_at=now() WHERE id=$1",[recordId,actor.id],db);
    await journal(db,String(invoice.id),'funding',recordId,agreement.repayment_amount,agreement.currency);
    await rows("UPDATE invoices SET status='funded',updated_at=now() WHERE id=$1",[invoice.id],db);
  }else await rows("UPDATE fundings SET status='rejected',updated_at=now() WHERE id=$1",[recordId],db);
  const [after]=await rows('SELECT * FROM fundings WHERE id=$1',[recordId],db);
  await audit(db,actor,String(invoice.id),`funding.${action==='confirm'?'confirmed':'rejected'}`,'funding',recordId,{before:funding,after});
  return after;
}
async function recordReceipt(actor:Actor,invoice:Row,body:Record<string,unknown>,db:DB,reversalId?:string) {
  if(reversalId)requireRole(actor,'platform_ops');
  else requireCondition(actor.role==='platform_ops'||actor.role==='buyer_admin'&&same(actor.buyer_id,invoice.buyer_id),403,'Only the buyer or operations may record a repayment');
  const [funding]=await rows("SELECT * FROM fundings WHERE invoice_id=$1 AND status='completed'",[invoice.id],db);
  requireCondition(funding,409,'Verified funding is required');
  let amount:string;let unit:string;let reason:string|null=null;
  rejectManagedFields('repayments',body);
  const payment={...fieldSchema('repayments',false,{optional:true,exclude:['amount','currency','reason',...Object.keys(paymentInput.shape)]}).parse(body),...paymentInput.parse(body)};
  requireCondition(payment.payment_date>=funding.payment_date,422,'Receipt or reversal cannot precede the disbursement');
  if(reversalId){
    const data=reversalInput.parse(body);
    const [original]=await rows("SELECT * FROM repayments WHERE id=$1 AND invoice_id=$2 AND kind='receipt' AND status='completed'",[reversalId,invoice.id],db);
    requireCondition(original,404,'Confirmed receipt not found');
    requireCondition(payment.payment_date>=original.payment_date,422,'Reversal cannot precede the original receipt');
    amount=original.amount;unit=original.currency;reason=data.reason;
  }else {
    const data=receiptInput.parse(body);amount=data.amount;unit=data.currency;
    requireCondition(unit===funding.currency,422,'Receipt currency must match the agreement');
  }
  const values={...databaseValues('repayments',payment),funding_id:funding.id,invoice_id:invoice.id,kind:reversalId?'reversal':'receipt',reversal_of_id:reversalId??null,amount,currency:unit,reason,recorded_by:actor.id};
  const [receipt]=await insertFinancial('repayments',values,db);
  await audit(db,actor,String(invoice.id),`repayment.${receipt.kind}_recorded`,'repayment',String(receipt.id),{after:receipt});
  return receipt;
}
async function decideReceipt(actor:Actor,invoice:Row,recordId:string,action:string,db:DB) {
  requireRole(actor,'platform_ops');
  const [receipt]=await rows('SELECT * FROM repayments WHERE id=$1 AND invoice_id=$2 FOR UPDATE',[recordId,invoice.id],db);
  requireCondition(receipt,404,'Repayment record not found');
  requireCondition(receipt.status==='pending',409,'Repayment evidence has already been decided');
  requireCondition(!same(actor.id,receipt.recorded_by)&&!await preparedOnBehalfBy(actor.id,'repayment',recordId,db),403,'The recorder cannot verify or reject their own receipt');
  if(action==='confirm') {
    const [position]=await rows('SELECT * FROM financial_positions WHERE funding_id=$1',[receipt.funding_id],db);
    requireCondition(position,409,'Verified funding is required');
    if(receipt.kind==='receipt')requireCondition(cents(receipt.amount)<=cents(position.outstanding_amount),409,'Receipt exceeds the outstanding obligation');
    else {
      const [original]=await rows("SELECT * FROM repayments WHERE id=$1 AND status='completed' AND kind='receipt'",[receipt.reversal_of_id],db);
      requireCondition(original&&same(original.funding_id,receipt.funding_id)&&original.amount===receipt.amount,409,'Reversal does not match the original confirmed receipt');
    }
    const closing=cents(position.outstanding_amount)+(receipt.kind==='receipt'?-cents(receipt.amount):cents(receipt.amount));
    await rows("UPDATE repayments SET status='completed',confirmed_by=$2,confirmed_at=now(),updated_at=now(),outstanding_balance=$3 WHERE id=$1",[recordId,actor.id,decimal(closing)],db);
    await journal(db,String(invoice.id),receipt.kind,recordId,receipt.amount,receipt.currency);
    const [afterPosition]=await rows('SELECT * FROM financial_positions WHERE funding_id=$1',[receipt.funding_id],db);
    await rows('UPDATE invoices SET status=$2,updated_at=now() WHERE id=$1',[invoice.id,cents(afterPosition.outstanding_amount)===BigInt(0)?'repaid':'funded'],db);
  }else await rows("UPDATE repayments SET status='rejected',updated_at=now() WHERE id=$1",[recordId],db);
  const [after]=await rows('SELECT * FROM repayments WHERE id=$1',[recordId],db);
  const [position]=await rows('SELECT * FROM financial_positions WHERE funding_id=$1',[receipt.funding_id],db);
  await audit(db,actor,String(invoice.id),`repayment.${receipt.kind}_${action==='confirm'?'confirmed':'rejected'}`,'repayment',recordId,{before:receipt,after,position});
  return after;
}

/** Financial writes serialize on the invoice. Permission, idempotency, evidence, journal and audit commit together. */
export async function financeRequest(actor:Actor,method:string,path:string[],input:Record<string,unknown>):Promise<{data:unknown;status?:number}> {
  const [resource,rawId,action,rawChildId,childAction]=path;
  let invoiceId:string;let recordId:string|undefined;
  const routeId=id.parse(rawId);
  if(resource==='invoices')invoiceId=routeId;
  else {
    recordId=routeId;
    const lookup=resource==='agreements'?'financing_agreements':resource==='fundings'?'fundings':resource==='repayments'?'repayments':null;
    requireCondition(lookup,404,'Not found');
    const [record]=await rows(`SELECT invoice_id FROM ${lookup} WHERE id=$1`,[recordId]);
    requireCondition(record,404,'Not found');invoiceId=String(record.invoice_id);
  }
  const read=resource==='invoices'&&action==='financials'&&path.length===3&&method==='GET';
  if(!read){
    requireCondition(method==='POST',405,'Use POST for financial actions');
    assertFinancialRelease();
  }
  const body=z.record(z.string(),z.unknown()).parse(input.agreement??input.funding??input.repayment??input);
  return transaction(async db=>{
    const invoice=await invoiceContext(actor,invoiceId,db,!read);
    if(read)return {data:await financialSnapshot(invoice,db)};
    requireCondition(!invoice.financial_review_required,409,'Legacy financial evidence requires reconciliation before further financial actions');
    const key=z.string().trim().min(8).max(100).parse(input.idempotency_key??body.idempotency_key);
    const operation=path.join('/');const hash=digest(JSON.stringify(stable(body)));
    const [existing]=await rows('SELECT * FROM financial_requests WHERE actor_id=$1 AND operation=$2 AND idempotency_key=$3',[actor.id,operation,key],db);
    if(existing){requireCondition(existing.payload_hash===hash,409,'Idempotency key was already used with a different payload');return {data:existing.result,status:200};}
    let result:Row;
    if(resource==='invoices'&&action==='agreements'&&path.length===3)result=await proposeAgreement(actor,invoice,body,db);
    else if(resource==='agreements'&&['sign','reject'].includes(action)&&path.length===3)result=await signAgreement(actor,invoice,recordId!,db,action);
    else if(resource==='invoices'&&action==='fundings'&&path.length===3)result=await recordFunding(actor,invoice,body,db);
    else if(resource==='fundings'&&['confirm','reject'].includes(action)&&path.length===3)result=await decideFunding(actor,invoice,recordId!,action,db);
    else if(resource==='invoices'&&action==='repayments'&&path.length===3)result=await recordReceipt(actor,invoice,body,db);
    else if(resource==='invoices'&&action==='repayments'&&rawChildId&&childAction==='reverse'&&path.length===5)result=await recordReceipt(actor,invoice,body,db,id.parse(rawChildId));
    else if(resource==='repayments'&&['confirm','reject'].includes(action)&&path.length===3)result=await decideReceipt(actor,invoice,recordId!,action,db);
    else throw new ApiError(404,'Financial action not found');
    await rows('INSERT INTO financial_requests(actor_id,operation,idempotency_key,payload_hash,result) VALUES($1,$2,$3,$4,$5)',[actor.id,operation,key,hash,JSON.stringify(result)],db);
    return {data:result,status:201};
  });
}
