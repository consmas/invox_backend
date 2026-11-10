-- Live portal workflows; existing financial evidence safeguards are retained.
ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title varchar(200);
ALTER TABLE users ADD COLUMN IF NOT EXISTS portal_registration boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_preferences jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret_encrypted text;
ALTER TABLE app_sessions ADD COLUMN IF NOT EXISTS mfa_verified_at timestamptz;
ALTER TABLE bids ADD COLUMN IF NOT EXISTS portal_state varchar(20);
ALTER TABLE bids ADD COLUMN IF NOT EXISTS proposed_disbursement_date date;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at timestamptz;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS uploaded_by bigint REFERENCES users(id);
CREATE TABLE portal_org_reviews (
 org_ref varchar PRIMARY KEY, status varchar NOT NULL DEFAULT 'PENDING_REVIEW' CHECK(status IN ('PENDING_REVIEW','INFO_REQUIRED','APPROVED','REJECTED')),
 payload jsonb NOT NULL DEFAULT '{}', note text, submitted_by bigint NOT NULL REFERENCES users(id), submitted_at timestamptz NOT NULL DEFAULT now(), reviewed_by bigint REFERENCES users(id), reviewed_at timestamptz
);
CREATE TABLE portal_email_codes(user_id bigint PRIMARY KEY REFERENCES users(id),code_hash varchar NOT NULL,expires_at timestamptz NOT NULL,attempts integer NOT NULL DEFAULT 0);
CREATE TABLE portal_mfa_challenges(token_hash varchar PRIMARY KEY,user_id bigint NOT NULL REFERENCES users(id),expires_at timestamptz NOT NULL,attempts integer NOT NULL DEFAULT 0);
CREATE TABLE portal_tender_invitations(tender_id bigint NOT NULL REFERENCES financing_tenders(id),financer_id bigint NOT NULL REFERENCES users(id),PRIMARY KEY(tender_id,financer_id));
CREATE TABLE portal_programme_suppliers(programme_id bigint REFERENCES programmes(id),supplier_id bigint REFERENCES suppliers(id),PRIMARY KEY(programme_id,supplier_id));
CREATE TABLE portal_programme_financiers(programme_id bigint REFERENCES programmes(id),financer_id bigint REFERENCES users(id),PRIMARY KEY(programme_id,financer_id));
CREATE TABLE portal_events(id bigserial PRIMARY KEY,actor_id bigint REFERENCES users(id),org_ref varchar,invoice_id bigint REFERENCES invoices(id),event varchar NOT NULL,reason text,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE TRIGGER portal_events_append_only BEFORE UPDATE OR DELETE ON portal_events FOR EACH ROW EXECUTE FUNCTION refuse_financial_mutation();
CREATE TABLE portal_exceptions(id bigserial PRIMARY KEY,invoice_id bigint REFERENCES invoices(id),org_ref varchar,kind varchar NOT NULL,summary text NOT NULL,status varchar NOT NULL DEFAULT 'OPEN',resolution_note text,updated_by bigint REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE portal_configuration(key varchar PRIMARY KEY,value jsonb NOT NULL,updated_by bigint NOT NULL REFERENCES users(id),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE portal_messages(id bigserial PRIMARY KEY,user_id bigint REFERENCES users(id),name varchar(200) NOT NULL,email varchar(254) NOT NULL,company varchar(200),subject varchar(200),body text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX one_portal_open_tender ON financing_tenders(invoice_id) WHERE status='open';
CREATE INDEX portal_notifications_user ON notifications(user_id,id DESC);
CREATE INDEX portal_events_invoice ON portal_events(invoice_id,id);

ALTER TABLE financing_tenders ADD COLUMN IF NOT EXISTS accepted_bid_id bigint REFERENCES bids(id);
