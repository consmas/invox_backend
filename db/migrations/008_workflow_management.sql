-- Drafts may be incomplete; submitted/financial records retain their history.
ALTER TABLE invoices ALTER COLUMN amount DROP NOT NULL;
ALTER TABLE invoices ADD CONSTRAINT invoice_amount_required_after_draft CHECK(status='draft' OR amount IS NOT NULL);
ALTER TABLE invoices ADD CONSTRAINT invoice_positive_amount_when_present CHECK(amount IS NULL OR amount>0);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cancelled_by bigint REFERENCES users(id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cancellation_reason text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS archived_by bigint REFERENCES users(id);
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS archive_reason text;
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS activated_at timestamptz;
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS paused_at timestamptz;
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS created_by bigint REFERENCES users(id);
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE financier_profiles ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at timestamptz;
ALTER TABLE financing_tenders ADD COLUMN IF NOT EXISTS cancellation_reason text;
ALTER TABLE financing_tenders ADD COLUMN IF NOT EXISTS cancelled_by bigint REFERENCES users(id);
ALTER TABLE financing_tenders ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE mandate_versions ADD COLUMN IF NOT EXISTS approved_by bigint REFERENCES users(id);
ALTER TABLE mandate_versions ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE limits ADD COLUMN IF NOT EXISTS approved_at timestamptz;
CREATE TABLE portal_supplier_relationships (
 buyer_id bigint NOT NULL REFERENCES buyers(id),supplier_id bigint NOT NULL REFERENCES suppliers(id),
 contact_name varchar(200),contact_email varchar(254),contact_phone varchar(100),payment_terms text,notes text,
 status varchar NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
 created_by bigint REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(buyer_id,supplier_id)
);
INSERT INTO portal_supplier_relationships(buyer_id,supplier_id)
 SELECT DISTINCT p.buyer_id,ps.supplier_id FROM portal_programme_suppliers ps JOIN programmes p ON p.id=ps.programme_id
 UNION SELECT DISTINCT p.buyer_id,i.supplier_id FROM invoices i JOIN programmes p ON p.id=i.programme_id
 ON CONFLICT DO NOTHING;
-- Existing invoice status constraints are extended, never normalised/replaced on stored rows.
DO $$
DECLARE r record; definition text;
BEGIN
 FOR r IN SELECT oid,conname FROM pg_constraint WHERE conrelid='invoices'::regclass AND contype='c'
 LOOP
  definition=pg_get_constraintdef(r.oid);
  IF definition LIKE '%repaid%' AND definition LIKE '%draft%' AND definition NOT LIKE '%amount%' THEN
   EXECUTE format('ALTER TABLE invoices DROP CONSTRAINT %I',r.conname);
   EXECUTE format('ALTER TABLE invoices ADD CONSTRAINT %I CHECK(status IN (''draft'',''approved'',''tender'',''funded'',''repaid'',''cancelled''))',r.conname);
  END IF;
 END LOOP;
END $$;
ALTER TABLE limits ADD COLUMN IF NOT EXISTS created_by bigint REFERENCES users(id);
ALTER TABLE conditions_precedent ADD COLUMN IF NOT EXISTS created_by bigint REFERENCES users(id);
ALTER TABLE financing_requests ADD COLUMN IF NOT EXISTS created_by bigint REFERENCES users(id);
ALTER TABLE reconciliation_cases ADD COLUMN IF NOT EXISTS created_by bigint REFERENCES users(id);
ALTER TABLE mandate_versions ADD COLUMN IF NOT EXISTS last_modified_by bigint REFERENCES users(id);
ALTER TABLE limits ADD COLUMN IF NOT EXISTS last_modified_by bigint REFERENCES users(id);
ALTER TABLE conditions_precedent ADD COLUMN IF NOT EXISTS last_modified_by bigint REFERENCES users(id);
ALTER TABLE financing_requests ADD COLUMN IF NOT EXISTS last_modified_by bigint REFERENCES users(id);
ALTER TABLE reconciliation_cases ADD COLUMN IF NOT EXISTS last_modified_by bigint REFERENCES users(id);
ALTER TABLE financing_requests ADD COLUMN IF NOT EXISTS reviewed_by bigint REFERENCES users(id);
ALTER TABLE financing_requests ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE financing_requests ADD COLUMN IF NOT EXISTS review_note text;
ALTER TABLE financing_requests ADD COLUMN IF NOT EXISTS tender_id bigint REFERENCES financing_tenders(id);
