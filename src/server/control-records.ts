import { z } from 'zod';
import { type Actor,requireRole } from './auth';
import { rows,transaction,type Row } from './db';
import { requireCondition,ApiError } from './errors';
import { id } from './validation';
import { fieldCatalog,fieldSchema,rejectManagedFields,databaseValues,validateFieldReferences,entityAudit } from './fields';

export async function definitions(actor:Actor,path:string[]){
  if(path.length===1)return {data:Object.values(fieldCatalog).filter(entity=>entity.core||actor.role==='platform_ops')};
  requireCondition(path.length===2&&fieldCatalog[path[1]],404,'Unknown field definition');
  const definition=fieldCatalog[path[1]];
  if(!definition.core)requireRole(actor,'platform_ops');
  return {data:definition};
}
export async function lookup(actor:Actor,entity:string){
  requireCondition(entity==='users'||fieldCatalog[entity],404,'Unknown relation');
  const table=entity==='financers'?'users':entity==='agreements'?'financing_agreements':entity;
  if(actor.role!=='platform_ops'){
    requireCondition(entity==='documents',403,'This lookup is restricted to operations');
    const list=actor.role==='buyer_admin'?await rows('SELECT id,file_name AS name FROM documents WHERE buyer_id=$1 ORDER BY id DESC LIMIT 250',[actor.buyer_id]):
      actor.role==='supplier_user'?await rows('SELECT d.id,d.file_name AS name FROM documents d JOIN suppliers s ON s.id=d.supplier_id WHERE s.user_id=$1 ORDER BY d.id DESC LIMIT 250',[actor.id]):[];
    return {data:list};
  }
  return {data:await rows(`SELECT t.id,coalesce(to_jsonb(t)->>'name',to_jsonb(t)->>'file_name',to_jsonb(t)->>'email',to_jsonb(t)->>'invoice_number',to_jsonb(t)->>'programme_reference',to_jsonb(t)->>'payment_reference',t.id::text) AS name FROM "${table}" t ${entity==='financers'?'WHERE role=3':''} ORDER BY id DESC LIMIT 250`)};
}
export async function controlRecords(actor:Actor,method:string,path:string[],body:Record<string,unknown>){
  requireRole(actor,'platform_ops');
  const entity=path[1];const definition=fieldCatalog[entity];
  requireCondition(definition&&!definition.core&&path.length<=3,404,'Unknown control record type');
  const recordId=path[2]?id.parse(path[2]):undefined;
  return transaction(async db=>{
    const safe=definition.fields.filter(field=>!field.protected).map(field=>`"${field.key}"`);
    const select=['id','created_by','created_at','updated_at',...safe.filter(key=>key!=='"created_by"')].join(',');
    const previous:Row|undefined=recordId?(await rows(`SELECT ${select} FROM "${entity}" WHERE id=$1 FOR UPDATE`,[recordId],db))[0]:undefined;
    if(recordId)requireCondition(previous,404,'Record not found');
    if(method==='GET')return {data:recordId?previous:await rows(`SELECT ${select} FROM "${entity}" ORDER BY id DESC LIMIT 250`,[],db)};
    requireCondition(method==='POST'&&!recordId||method==='PATCH'&&recordId,405,'Only creation and draft-field updates are supported');
    if(entity==='bank_accounts')throw new ApiError(403,'Bank-detail entry is locked until verified MFA enrolment and step-up authentication are available');
    const input=z.record(z.string(),z.unknown()).parse(body.record??body);
    rejectManagedFields(entity,input);
    const data=fieldSchema(entity,!!recordId).strict().parse(input);
    await validateFieldReferences(entity,{...previous,...data},actor,db);
    const encoded=databaseValues(entity,data);
    const keys=Object.keys(encoded);
    if(!recordId){encoded.created_by=actor.id;keys.push('created_by');}
    requireCondition(keys.length>0,422,'No editable fields were supplied');
    let result:Row;
    if(recordId){
      requireCondition(!previous?.status||['draft','pending','open','planned','queued'].includes(previous.status),409,'Reviewed records cannot be edited');
      [result]=await rows(`UPDATE "${entity}" SET ${keys.map((key,index)=>`"${key}"=$${index+2}`).join(',')},updated_at=now() WHERE id=$1 RETURNING ${select}`,[recordId,...Object.values(encoded)],db);
    }else [result]=await rows(`INSERT INTO "${entity}" (${keys.map(key=>`"${key}"`).join(',')}) VALUES(${keys.map((_,index)=>`$${index+1}`).join(',')}) RETURNING ${select}`,Object.values(encoded),db);
    await entityAudit(db,actor,entity,String(result.id),recordId?'updated':'created',previous??null,result);
    return {data:result,status:recordId?200:201};
  });
}
