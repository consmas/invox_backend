-- Runs transactionally on a fresh PostgreSQL database or a copy of the Rails database.
CREATE TABLE IF NOT EXISTS buyers (
  id bigserial PRIMARY KEY, name varchar NOT NULL, registration_number varchar NOT NULL DEFAULT '',
  address varchar NOT NULL DEFAULT '', contact_email varchar NOT NULL DEFAULT '',
  created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
  id bigserial PRIMARY KEY, email varchar NOT NULL DEFAULT '', encrypted_password varchar NOT NULL DEFAULT '',
  reset_password_token varchar, reset_password_sent_at timestamp, remember_created_at timestamp,
  jti varchar NOT NULL, role integer NOT NULL DEFAULT 0, buyer_id bigint REFERENCES buyers(id),
  created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS index_users_on_email ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS index_users_on_jti ON users(jti);
CREATE UNIQUE INDEX IF NOT EXISTS index_users_on_reset_password_token ON users(reset_password_token);
CREATE INDEX IF NOT EXISTS index_users_on_buyer_id ON users(buyer_id);
CREATE TABLE IF NOT EXISTS suppliers (
  id bigserial PRIMARY KEY, name varchar NOT NULL, email varchar NOT NULL, company varchar,
  invited_at timestamp, invitation_token varchar, user_id bigint NOT NULL REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS invitation_expires_at timestamp;
CREATE UNIQUE INDEX IF NOT EXISTS index_suppliers_on_email ON suppliers(email);
CREATE INDEX IF NOT EXISTS index_suppliers_on_user_id ON suppliers(user_id);
CREATE TABLE IF NOT EXISTS programmes (
  id bigserial PRIMARY KEY, buyer_id bigint NOT NULL REFERENCES buyers(id), name varchar NOT NULL,
  "limit" decimal, fee_percent decimal, maturity_days integer,
  created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS index_programmes_on_buyer_id ON programmes(buyer_id);
CREATE TABLE IF NOT EXISTS invoices (
  id bigserial PRIMARY KEY, invoice_number varchar, amount decimal(10,2) NOT NULL, due_date date,
  status varchar NOT NULL DEFAULT 'draft', programme_id bigint NOT NULL REFERENCES programmes(id),
  supplier_id bigint NOT NULL REFERENCES suppliers(id),
  created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS index_invoices_on_programme_id ON invoices(programme_id);
CREATE INDEX IF NOT EXISTS index_invoices_on_supplier_id ON invoices(supplier_id);
-- Rails shipped an integer enum over a varchar column. Preserve and normalize both formats.
ALTER TABLE invoices ALTER COLUMN status DROP DEFAULT;
ALTER TABLE invoices ALTER COLUMN status TYPE varchar USING status::text;
UPDATE invoices SET status = CASE status
  WHEN '0' THEN 'draft' WHEN '1' THEN 'approved' WHEN '2' THEN 'tender'
  WHEN '3' THEN 'funded' WHEN '4' THEN 'repaid' WHEN 'pending' THEN 'draft'
  WHEN 'paid' THEN 'repaid' ELSE coalesce(status, 'draft') END;
ALTER TABLE invoices ALTER COLUMN status SET DEFAULT 'draft';
DO $$ BEGIN
  IF EXISTS (SELECT id FROM invoices WHERE status NOT IN ('draft','approved','tender','funded','repaid')) THEN
    RAISE EXCEPTION 'Unknown legacy invoice status; map it to draft/approved/tender/funded/repaid before migration';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS bids (
  id bigserial PRIMARY KEY, invoice_id bigint NOT NULL REFERENCES invoices(id),
  financer_id bigint NOT NULL REFERENCES users(id), amount decimal(15,2) NOT NULL,
  status integer NOT NULL DEFAULT 0, expiry_date date,
  created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS index_bids_on_invoice_id ON bids(invoice_id);
CREATE INDEX IF NOT EXISTS index_bids_on_financer_id ON bids(financer_id);
DO $$ BEGIN
  IF EXISTS (SELECT invoice_id FROM bids WHERE status = 1 GROUP BY invoice_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Resolve invoices with multiple accepted bids before migration; no changes have been committed';
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS one_accepted_bid_per_invoice ON bids(invoice_id) WHERE status = 1;
-- Accepted offers are not evidence of payment. Legacy settlement is reviewed separately.
CREATE TABLE IF NOT EXISTS app_sessions (
  token_hash varchar PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_jti varchar NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_sessions_user_id ON app_sessions(user_id);
CREATE INDEX IF NOT EXISTS app_sessions_expiry ON app_sessions(expires_at);
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  key varchar PRIMARY KEY, attempts integer NOT NULL DEFAULT 1, window_start timestamptz NOT NULL DEFAULT now()
);
