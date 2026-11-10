import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

test('existing Rails rows, IDs and password hashes survive migration; numeric statuses normalize',async()=>{
  const connection=process.env.TEST_DATABASE_URL;
  assert.ok(connection&&new URL(connection).pathname.endsWith('_test'),'Use an isolated TEST_DATABASE_URL ending in _test');
  const db=new Pool({connectionString:connection});const client=await db.connect();const schema=`legacy_test_${process.pid}_${Date.now()}`;
  const migration=await readFile(new URL('../db/migrations/001_next_backend.sql',import.meta.url),'utf8');
  try{
    await client.query(`CREATE SCHEMA "${schema}"`);await client.query(`SET search_path TO "${schema}"`);
    // Create the same business tables, then populate the broken varchar enum format Rails wrote.
    await client.query(migration);
    await client.query("INSERT INTO buyers(id,name,registration_number,contact_email) VALUES (7,'Legacy buyer','LEGACY','legacy@example.test')");
    await client.query("INSERT INTO users(id,email,encrypted_password,jti,role,buyer_id) VALUES (42,'legacy@example.test','$2a$legacy-hash-preserved','legacy-jti',1,7),(43,'fund@example.test','hash','fund-jti',3,NULL)");
    await client.query("INSERT INTO suppliers(id,name,email,user_id) VALUES (9,'Legacy supplier','legacy@example.test',42)");
    await client.query("INSERT INTO programmes(id,buyer_id,name) VALUES (10,7,'Legacy programme')");
    await client.query("INSERT INTO invoices(id,programme_id,supplier_id,amount,status) VALUES (11,10,9,500,'2'),(12,10,9,600,'pending')");
    await client.query("INSERT INTO bids(invoice_id,financer_id,amount,status) VALUES (11,43,450,1)");
    await client.query('BEGIN');await client.query(migration);await client.query('COMMIT');
    const result=await client.query('SELECT id,supplier_id,status FROM invoices ORDER BY id');
    assert.deepEqual(result.rows,[{id:'11',supplier_id:'9',status:'tender'},{id:'12',supplier_id:'9',status:'draft'}]);
    assert.equal((await client.query('SELECT encrypted_password FROM users WHERE id=42')).rows[0].encrypted_password,'$2a$legacy-hash-preserved');
    // A second run is safe and does not recreate or erase business records.
    await client.query(migration);assert.equal((await client.query('SELECT count(*)::integer AS count FROM invoices')).rows[0].count,2);
    // Ambiguous winners abort the entire migration rather than silently choosing a financer.
    await client.query('DROP INDEX one_accepted_bid_per_invoice');
    await client.query("INSERT INTO bids(invoice_id,financer_id,amount,status) VALUES (11,43,440,1)");
    await client.query("UPDATE invoices SET status='2' WHERE id=11");
    await client.query('BEGIN');await assert.rejects(client.query(migration),/multiple accepted bids/);await client.query('ROLLBACK');
    assert.equal((await client.query('SELECT status FROM invoices WHERE id=11')).rows[0].status,'2');
    await client.query("DELETE FROM bids WHERE amount=440");
    await client.query("UPDATE invoices SET status='tender' WHERE id=11");
    await client.query("UPDATE invoices SET status='funded' WHERE id=12");
    await client.query("INSERT INTO invoices(id,programme_id,supplier_id,amount,status) VALUES(13,10,9,700,'tender')");
    await client.query("INSERT INTO bids(invoice_id,financer_id,amount,status) VALUES(13,43,650,0)");
    await client.query(await readFile(new URL('../db/migrations/002_financial_controls.sql',import.meta.url),'utf8'));
    const flagged=(await client.query('SELECT id,status,financial_review_required FROM invoices ORDER BY id')).rows;
    assert.deepEqual(flagged,[{id:'11',status:'tender',financial_review_required:true},{id:'12',status:'funded',financial_review_required:true},{id:'13',status:'tender',financial_review_required:true}]);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM fundings')).rows[0].count,0);
    await client.query(await readFile(new URL('../db/migrations/003_requirement_fields.sql',import.meta.url),'utf8'));
    assert.equal((await client.query('SELECT count(*)::int AS count FROM invoices')).rows[0].count,3);
    assert.equal((await client.query('SELECT encrypted_password FROM users WHERE id=42')).rows[0].encrypted_password,'$2a$legacy-hash-preserved');
    await client.query(await readFile(new URL('../db/migrations/004_additional_control_fields.sql',import.meta.url),'utf8'));
    await client.query(await readFile(new URL('../db/migrations/005_user_profile_fields.sql',import.meta.url),'utf8'));
    assert.equal((await client.query('SELECT invoice_number FROM invoices WHERE id=11')).rows[0].invoice_number,null);

  }finally{
    await client.query('ROLLBACK');await client.query('SET search_path TO public');await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);client.release();await db.end();
  }
});
