ALTER TABLE invoices ADD COLUMN IF NOT EXISTS currency varchar(3);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS financial_review_required boolean NOT NULL DEFAULT false;
UPDATE invoices SET financial_review_required=true
WHERE status IN ('funded','repaid') OR EXISTS (SELECT 1 FROM bids WHERE bids.invoice_id=invoices.id AND (bids.status=1 OR invoices.currency IS NULL));

CREATE TABLE financing_agreements (
  id bigserial PRIMARY KEY,
  invoice_id bigint NOT NULL REFERENCES invoices(id),
  bid_id bigint NOT NULL REFERENCES bids(id),
  currency varchar(3) NOT NULL CHECK (currency IN ('GHS','USD','EUR')),
  net_disbursement numeric(18,2) NOT NULL CHECK (net_disbursement>0),
  repayment_amount numeric(18,2) NOT NULL CHECK (repayment_amount>=net_disbursement),
  maturity_date date NOT NULL,
  document_reference text NOT NULL CHECK (length(document_reference)>0),
  proposed_by bigint NOT NULL REFERENCES users(id),
  signed_by bigint REFERENCES users(id),
  signed_at timestamptz,
  status varchar NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','signed','rejected')),
  CHECK (signed_by IS NULL OR signed_by<>proposed_by),
  CHECK ((status='signed')=(signed_by IS NOT NULL AND signed_at IS NOT NULL)),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_active_agreement_per_invoice ON financing_agreements(invoice_id) WHERE status IN ('proposed','signed');
CREATE UNIQUE INDEX one_active_agreement_per_bid ON financing_agreements(bid_id) WHERE status IN ('proposed','signed');
CREATE TABLE fundings (
  id bigserial PRIMARY KEY,
  agreement_id bigint NOT NULL REFERENCES financing_agreements(id),
  invoice_id bigint NOT NULL REFERENCES invoices(id),
  amount numeric(18,2) NOT NULL CHECK (amount>0),
  currency varchar(3) NOT NULL CHECK (currency IN ('GHS','USD','EUR')),
  payment_reference varchar(200) NOT NULL UNIQUE,
  evidence_reference text NOT NULL,
  payment_date date NOT NULL,
  recorded_by bigint NOT NULL REFERENCES users(id),
  confirmed_by bigint REFERENCES users(id), confirmed_at timestamptz,
  status varchar NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','rejected')),
  CHECK (confirmed_by IS NULL OR confirmed_by<>recorded_by),
  CHECK ((status='completed')=(confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_active_funding_per_invoice ON fundings(invoice_id) WHERE status IN ('pending','completed');
CREATE TABLE repayments (
  id bigserial PRIMARY KEY,
  funding_id bigint NOT NULL REFERENCES fundings(id),
  invoice_id bigint NOT NULL REFERENCES invoices(id),
  kind varchar NOT NULL DEFAULT 'receipt' CHECK (kind IN ('receipt','reversal')),
  reversal_of_id bigint REFERENCES repayments(id),
  amount numeric(18,2) NOT NULL CHECK (amount>0),
  currency varchar(3) NOT NULL CHECK (currency IN ('GHS','USD','EUR')),
  payment_reference varchar(200) NOT NULL UNIQUE,
  evidence_reference text NOT NULL,
  payment_date date NOT NULL,
  reason text,
  recorded_by bigint NOT NULL REFERENCES users(id),
  confirmed_by bigint REFERENCES users(id), confirmed_at timestamptz,
  status varchar NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','rejected')),
  CHECK ((kind='reversal')=(reversal_of_id IS NOT NULL)),
  CHECK (confirmed_by IS NULL OR confirmed_by<>recorded_by),
  CHECK ((status='completed')=(confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_active_reversal_per_receipt ON repayments(reversal_of_id) WHERE kind='reversal' AND status IN ('pending','completed');
CREATE INDEX repayments_by_funding ON repayments(funding_id);
CREATE TABLE financial_requests (
  actor_id bigint NOT NULL REFERENCES users(id),
  operation varchar NOT NULL, idempotency_key varchar(100) NOT NULL,
  payload_hash varchar(64) NOT NULL, result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_id,operation,idempotency_key)
);
CREATE TABLE audit_events (
  id bigserial PRIMARY KEY, actor_id bigint NOT NULL REFERENCES users(id),
  invoice_id bigint NOT NULL REFERENCES invoices(id),
  event varchar NOT NULL, record_type varchar NOT NULL, record_id bigint NOT NULL,
  details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_by_invoice ON audit_events(invoice_id,id);
CREATE TABLE ledger_journals (
  id bigserial PRIMARY KEY, invoice_id bigint NOT NULL REFERENCES invoices(id),
  source_type varchar NOT NULL CHECK (source_type IN ('funding','receipt','reversal')),
  source_id bigint NOT NULL, currency varchar(3) NOT NULL,
  book varchar NOT NULL DEFAULT 'administered_positions' CHECK (book='administered_positions'),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source_type,source_id)
);
CREATE TABLE ledger_lines (
  id bigserial PRIMARY KEY, journal_id bigint NOT NULL REFERENCES ledger_journals(id),
  account_code varchar NOT NULL CHECK (account_code IN ('buyer_obligation','funder_entitlement')),
  side varchar NOT NULL CHECK (side IN ('debit','credit')),
  amount numeric(18,2) NOT NULL CHECK (amount>0)
);
CREATE FUNCTION refuse_financial_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Financial evidence and journals are append-only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION refuse_financial_mutation();
CREATE TRIGGER immutable_journals BEFORE UPDATE OR DELETE ON ledger_journals FOR EACH ROW EXECUTE FUNCTION refuse_financial_mutation();
CREATE TRIGGER immutable_lines BEFORE UPDATE OR DELETE ON ledger_lines FOR EACH ROW EXECUTE FUNCTION refuse_financial_mutation();
CREATE TRIGGER immutable_requests BEFORE UPDATE OR DELETE ON financial_requests FOR EACH ROW EXECUTE FUNCTION refuse_financial_mutation();
CREATE FUNCTION protect_completed_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.status IN ('completed','signed','rejected') THEN
    RAISE EXCEPTION 'Completed financial records cannot be edited or deleted' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_agreement BEFORE UPDATE OR DELETE ON financing_agreements FOR EACH ROW EXECUTE FUNCTION protect_completed_record();
CREATE TRIGGER protect_funding BEFORE UPDATE OR DELETE ON fundings FOR EACH ROW EXECUTE FUNCTION protect_completed_record();
CREATE TRIGGER protect_repayment BEFORE UPDATE OR DELETE ON repayments FOR EACH ROW EXECUTE FUNCTION protect_completed_record();
CREATE FUNCTION enforce_balanced_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id bigint; debits numeric; credits numeric; entries integer;
BEGIN
  IF TG_TABLE_NAME='ledger_journals' THEN target_id:=NEW.id; ELSE target_id:=NEW.journal_id; END IF;
  SELECT count(*),coalesce(sum(amount) FILTER(WHERE side='debit'),0),coalesce(sum(amount) FILTER(WHERE side='credit'),0)
    INTO entries,debits,credits FROM ledger_lines WHERE journal_id=target_id;
  IF entries<2 OR debits<>credits OR debits<=0 THEN
    RAISE EXCEPTION 'Journal must contain balanced debit and credit entries' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER balanced_journal AFTER INSERT ON ledger_journals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_balanced_journal();
CREATE CONSTRAINT TRIGGER balanced_lines AFTER INSERT ON ledger_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_balanced_journal();

CREATE VIEW financial_positions AS
SELECT f.id AS funding_id,f.invoice_id,a.currency,a.repayment_amount,
  coalesce(sum(CASE WHEN r.kind='receipt' THEN r.amount ELSE -r.amount END) FILTER(WHERE r.status='completed'),0)::numeric(18,2) AS received_amount,
  (a.repayment_amount-coalesce(sum(CASE WHEN r.kind='receipt' THEN r.amount ELSE -r.amount END) FILTER(WHERE r.status='completed'),0))::numeric(18,2) AS outstanding_amount
FROM fundings f JOIN financing_agreements a ON a.id=f.agreement_id
LEFT JOIN repayments r ON r.funding_id=f.id
WHERE f.status='completed' GROUP BY f.id,a.id;
