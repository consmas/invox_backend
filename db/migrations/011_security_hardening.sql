-- Security audit 2026-11-12 remediation. Additive: no existing business rows are rewritten except
-- deriving invoice_number_normalized, and pending sign-in challenges (5-minute lifetime) are discarded.

-- F05: an MFA challenge is bound to the credential epoch (users.jti) that existed when the password was checked.
DELETE FROM portal_mfa_challenges;
ALTER TABLE portal_mfa_challenges ADD COLUMN IF NOT EXISTS user_jti varchar NOT NULL;
CREATE INDEX IF NOT EXISTS portal_mfa_challenges_user ON portal_mfa_challenges(user_id);

-- F06: the last accepted TOTP time step per authenticator; codes at or before it are refused.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_last_used_step bigint;

-- F18: one active economic claim per buyer, supplier and invoice reference (case and whitespace insensitive),
-- across all of the buyer's programmes. Existing duplicates are left untouched; new ones are refused.
UPDATE invoices SET invoice_number_normalized=upper(regexp_replace(invoice_number,'\s','','g'))
 WHERE invoice_number IS NOT NULL AND invoice_number_normalized IS DISTINCT FROM upper(regexp_replace(invoice_number,'\s','','g'));
CREATE INDEX IF NOT EXISTS invoices_claim_lookup ON invoices(supplier_id,invoice_number_normalized) WHERE deleted_at IS NULL;
CREATE OR REPLACE FUNCTION invoice_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE claim_buyer bigint;
BEGIN
  NEW.invoice_number_normalized := CASE WHEN NEW.invoice_number IS NULL THEN NULL ELSE upper(regexp_replace(NEW.invoice_number,'\s','','g')) END;
  IF NEW.invoice_number_normalized IS NULL OR NEW.invoice_number_normalized='' OR NEW.deleted_at IS NOT NULL OR NEW.status='cancelled' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.invoice_number_normalized IS NOT DISTINCT FROM OLD.invoice_number_normalized
     AND NEW.supplier_id IS NOT DISTINCT FROM OLD.supplier_id AND NEW.programme_id IS NOT DISTINCT FROM OLD.programme_id
     AND OLD.deleted_at IS NULL AND OLD.status IS DISTINCT FROM 'cancelled' THEN RETURN NEW; END IF;
  SELECT buyer_id INTO claim_buyer FROM programmes WHERE id=NEW.programme_id;
  -- Serialise competing claims for the same reference so concurrent inserts cannot both pass the check.
  PERFORM pg_advisory_xact_lock(hashtextextended(coalesce(claim_buyer::text,'')||':'||NEW.supplier_id::text||':'||NEW.invoice_number_normalized,72482903));
  IF EXISTS(SELECT 1 FROM invoices i JOIN programmes p ON p.id=i.programme_id
            WHERE i.supplier_id=NEW.supplier_id AND i.invoice_number_normalized=NEW.invoice_number_normalized
              AND p.buyer_id IS NOT DISTINCT FROM claim_buyer AND i.id<>NEW.id AND i.deleted_at IS NULL AND i.status<>'cancelled') THEN
    RAISE EXCEPTION 'An active invoice with this reference already exists for this buyer and supplier' USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS invoice_claim_guard ON invoices;
CREATE TRIGGER invoice_claim_guard BEFORE INSERT OR UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION invoice_claim_guard();

-- F10: selective indexes for the tenant, invitation and evidence lookups used on every request.
CREATE INDEX IF NOT EXISTS documents_uploaded_by ON documents(uploaded_by);
CREATE INDEX IF NOT EXISTS documents_buyer ON documents(buyer_id);
CREATE INDEX IF NOT EXISTS documents_invoice ON documents(invoice_id);
CREATE INDEX IF NOT EXISTS financing_tenders_invoice ON financing_tenders(invoice_id);
CREATE INDEX IF NOT EXISTS tender_invitations_financer ON portal_tender_invitations(financer_id);
CREATE INDEX IF NOT EXISTS programme_suppliers_supplier ON portal_programme_suppliers(supplier_id);
CREATE INDEX IF NOT EXISTS programme_financiers_financer ON portal_programme_financiers(financer_id);
CREATE INDEX IF NOT EXISTS supplier_relationships_supplier ON portal_supplier_relationships(supplier_id);
CREATE INDEX IF NOT EXISTS bids_invoice_financer ON bids(invoice_id,financer_id);
CREATE INDEX IF NOT EXISTS auth_rate_limits_window ON auth_rate_limits(window_start);
