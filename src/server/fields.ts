import { z } from 'zod';
import rawCatalog from '../domain/field-catalog.json';
import { id,date,email,password,buyerInput,programmeInput,invoiceInput,bidInput } from './validation';
import { cents,decimal } from './money';
import { requireCondition } from './errors';
import { rows,type DB,type Row } from './db';
import type { Actor } from './auth';

export type FieldDefinition={key:string;label:string;type:string;required:boolean;readOnly:boolean;reference?:string;options?:string[];default?:unknown;transient?:boolean;source?:string;protected?:boolean};
export type EntityDefinition={key:string;title:string;group:string;core:boolean;fields:FieldDefinition[]};
export const fieldCatalog=rawCatalog as Record<string,EntityDefinition>;
function structured(value:unknown){
  if(typeof value!=='string')return value;
  try{return JSON.parse(value);}catch{return value;}
}
function shape(field:FieldDefinition):z.ZodType {
  if(field.options)return z.enum(field.options as [string,...string[]]);
  switch(field.type){
    case 'email':return email;
    case 'password':return password;
    case 'country':return z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/,'Use a two-letter country code');
    case 'reference':return id;
    case 'money':case 'zero_money':return z.union([z.string(),z.number().finite()]).transform(String).refine(value=>{try{return field.type==='money'?cents(value)>BigInt(0):cents(value)>=BigInt(0);}catch{return false;}},'Invalid decimal amount').transform(value=>decimal(cents(value)));
    case 'integer':return z.union([z.number(),z.string().regex(/^\d+$/)]).transform(Number).pipe(z.number().int().min(0).max(2147483647));
    case 'rate':return z.union([z.string(),z.number().finite()]).transform(String).refine(value=>/^\d+(\.\d{1,6})?$/.test(value)&&BigInt(value.split('.')[0])*BigInt(1000000)+BigInt((value.split('.')[1]??'').padEnd(6,'0'))<=BigInt(100000000),'Use a percentage between 0 and 100 with at most six decimals');
    case 'decimal':return z.union([z.string(),z.number().finite()]).transform(String).pipe(z.string().regex(/^\d{1,16}(\.\d{1,8})?$/,'Invalid decimal value'));
    case 'date':return date;
    case 'timestamp':return z.string().datetime({offset:true});
    case 'boolean':return z.boolean();
    case 'json':return z.preprocess(structured,z.json().refine(value=>JSON.stringify(value).length<=50000,'Structured data is too large'));
    case 'string_array':return z.preprocess(structured,z.array(z.string().trim().min(1).max(500)).min(field.required?1:0).max(200));
    case 'document_array':return z.preprocess(structured,z.array(z.object({document_id:id,description:z.string().max(1000).optional()})).max(100));
    case 'sha256':return z.string().regex(/^[a-fA-F0-9]{64}$/,'Use a SHA-256 hexadecimal hash').transform(value=>value.toLowerCase());
    case 'longtext':return z.string().trim().min(field.required?1:0).max(20000);
    case 'secret':return z.string().trim().min(1).max(500);
    default:return z.string().trim().min(field.required?1:0).max(500);
  }
}
export function fieldSchema(entity:string,partial=false,options:{optional?:boolean;exclude?:string[]}={}){
  const definition=fieldCatalog[entity];requireCondition(definition,404,'Unknown record type');
  const fields:Record<string,z.ZodType>={};
  for(const field of definition.fields){
    if(field.readOnly||field.transient||options.exclude?.includes(field.key))continue;
    let validator=shape(field);
    if(!field.required||options.optional)validator=z.preprocess(value=>value===''?null:value,validator.nullable()).optional();
    else if(partial)validator=validator.optional();
    if(!partial&&field.default!==undefined)validator=validator.default(field.default);
    fields[field.key]=validator;
  }
  return z.object(fields);
}
const baseSchemas={buyers:buyerInput,programmes:programmeInput,invoices:invoiceInput,bids:bidInput};
export function coreSchema<K extends keyof typeof baseSchemas>(entity:K,partial=false){
  const base=baseSchemas[entity];
  const original:Record<string,z.ZodType>={...base.shape};
  if(partial)for(const key of Object.keys(original)){
    let validator=original[key];
    while(validator instanceof z.ZodDefault)validator=validator.unwrap() as z.ZodType;
    original[key]=validator.optional();
  }
  return z.object({...original,...fieldSchema(entity,partial,{exclude:Object.keys(base.shape)}).shape}).superRefine((value,context)=>{
    if(!partial)for(const field of fieldCatalog[entity].fields){
      if(field.required&&!field.readOnly&&!field.transient&&(value[field.key]==null||value[field.key]===''))context.addIssue({code:'custom',path:[field.key],message:`${field.label} is required`});
    }
  }) as unknown as z.ZodType<z.output<(typeof baseSchemas)[K]> & Record<string,unknown>>;
}
export function rejectManagedFields(entity:string,data:Record<string,unknown>){
  for(const field of fieldCatalog[entity].fields){
    requireCondition(!field.readOnly||data[field.key]===undefined,403,`${field.label} is assigned by its review workflow`);
  }
}
export function databaseValues(entity:string,data:Record<string,unknown>){
  const result={...data};
  for(const field of fieldCatalog[entity].fields){
    if(result[field.key]!==undefined&&result[field.key]!==null&&['json','string_array','document_array'].includes(field.type))result[field.key]=JSON.stringify(result[field.key]);
  }
  return result;
}
export async function validateFieldReferences(entity:string,data:Record<string,unknown>,actor:Actor,db:DB){
  const related:Record<string,Row>={};
  for(const field of fieldCatalog[entity].fields){
    if(field.reference&&data[field.key]!=null){
      const target=field.reference==='financers'?'users':field.reference==='agreements'?'financing_agreements':field.reference;
      requireCondition(target==='users'||fieldCatalog[field.reference],500,'Invalid configured relation');
      const [record]=await rows(`SELECT * FROM "${target}" WHERE id=$1${field.reference==='financers'?' AND role=3':''}`,[data[field.key]],db);
      requireCondition(record,422,`${field.label} does not exist`);
      related[field.key]=record;
      if(target==='documents'&&actor.role!=='platform_ops')requireCondition(String(record.buyer_id)===String(actor.buyer_id),403,'Document is outside your organisation');
    }
    if(field.type==='document_array'&&Array.isArray(data[field.key])){
      for(const reference of data[field.key] as {document_id:string}[]){
        const [record]=await rows('SELECT buyer_id FROM documents WHERE id=$1',[reference.document_id],db);
        requireCondition(record,422,'Supporting document does not exist');
        if(actor.role!=='platform_ops')requireCondition(String(record.buyer_id)===String(actor.buyer_id),403,'Supporting document is outside your organisation');
      }
    }
  }
  const same=(a:unknown,b:unknown)=>a==null||b==null||String(a)===String(b);
  const programme=related.programme_id;
  if(programme&&data.buyer_id)requireCondition(same(programme.buyer_id,data.buyer_id),422,'Programme and buyer must belong together');
  const invoice=related.invoice_id;
  if(invoice){
    requireCondition(same(invoice.programme_id,data.programme_id),422,'Invoice and programme must belong together');
    requireCondition(same(invoice.supplier_id,data.supplier_id),422,'Invoice and supplier must belong together');
    if(data.buyer_id){const [owner]=await rows('SELECT buyer_id FROM programmes WHERE id=$1',[invoice.programme_id],db);requireCondition(same(owner?.buyer_id,data.buyer_id),422,'Invoice and buyer must belong together');}
  }
  if(related.bid_id&&data.invoice_id)requireCondition(same(related.bid_id.invoice_id,data.invoice_id),422,'Bid and invoice must belong together');
  if(related.agreement_id&&data.invoice_id)requireCondition(same(related.agreement_id.invoice_id,data.invoice_id),422,'Agreement and invoice must belong together');
  for(const [start,end] of [['start_date','end_date'],['effective_from','effective_to'],['facility_start_date','facility_end_date'],['agreement_effective_date','agreement_expiry_date'],['issue_date','due_date']]){
    if(data[start]&&data[end])requireCondition(String(data[start])<=String(data[end]),422,`${end.replaceAll('_',' ')} cannot precede ${start.replaceAll('_',' ')}`);
  }

}
export async function entityAudit(db:DB,actor:Actor,entity:string,recordId:string,action:string,before:Row|null,after:Row|null){
  function redact(record:Row|null){
    if(!record)return null;const result={...record};
    for(const field of fieldCatalog[entity]?.fields??[]){if(field.protected||field.type==='password')delete result[field.key];}
    delete result.encrypted_password;delete result.invitation_token;delete result.reset_password_token;delete result.jti;delete result.mfa_secret_encrypted;delete result.mfa_last_used_step;
    return result;
  }
  await rows('INSERT INTO entity_audit_events(actor_id,entity,record_id,action,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6)',[actor.id,entity,recordId,action,JSON.stringify(redact(before)),JSON.stringify(redact(after))],db);
}
