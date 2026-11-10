import type { Actor } from './auth';
import { rows,type DB } from './db';
export async function audit(db:DB,actor:Actor,invoiceId:string,event:string,type:string,recordId:string,details:unknown) {
  await rows(`INSERT INTO audit_events(actor_id,invoice_id,event,record_type,record_id,details) VALUES($1,$2,$3,$4,$5,$6)`,[actor.id,invoiceId,event,type,recordId,JSON.stringify(details)],db);
}
