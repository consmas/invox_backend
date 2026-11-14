-- SRS Appendix B, increment 1 (A1, F1, S1): Syndicate-led set-up and access.
-- Anchors and funders are created by Syndicate from executed off-system paperwork behind a set-up gate; their named
-- users are pre-provisioned (not activated) with an organisation role; signatories and purpose contacts are
-- structured data. Organisation status is server-owned and every transition is audited. Suppliers join by an
-- anchor's invitation (email or SMS) and are never duplicated.

-- ── internal Syndicate roles (§3) and organisation user roles ─────────────────
-- NULL ops_roles = every internal role (operators created before roles existed, and the seeded super administrator).
ALTER TABLE users ADD COLUMN IF NOT EXISTS ops_roles text[];
ALTER TABLE users ADD COLUMN IF NOT EXISTS org_ref varchar;
ALTER TABLE users ADD COLUMN IF NOT EXISTS org_role varchar;
ALTER TABLE users ADD COLUMN IF NOT EXISTS provisioning_status varchar NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_limit numeric(20,2);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_ops_roles_check;
ALTER TABLE users ADD CONSTRAINT users_ops_roles_check CHECK (ops_roles IS NULL OR (role = 2 AND ops_roles <@ ARRAY['relationship_manager','compliance_officer','credit_risk_officer','operations_analyst','treasury','platform_admin']::text[]));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_org_role_check;
ALTER TABLE users ADD CONSTRAINT users_org_role_check CHECK (org_role IS NULL OR org_role IN ('administrator','approver','viewer','finance','relationship_owner','credit_officer','operations','auditor','custodian'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_provisioning_status_check;
ALTER TABLE users ADD CONSTRAINT users_provisioning_status_check CHECK (provisioning_status IN ('PROVISIONED_NOT_ACTIVATED','INVITED','ACTIVE','DISABLED'));
CREATE INDEX IF NOT EXISTS users_org_ref_idx ON users(org_ref) WHERE org_ref IS NOT NULL;
UPDATE users u SET org_ref='buyer-'||u.buyer_id WHERE u.buyer_id IS NOT NULL AND u.org_ref IS NULL;
UPDATE users u SET org_ref='supplier-'||s.id FROM suppliers s WHERE s.user_id=u.id AND u.org_ref IS NULL;
UPDATE users u SET org_ref='financier-'||u.id FROM financier_profiles f WHERE f.user_id=u.id AND u.org_ref IS NULL;

-- A supplier invited by mobile number alone has no account until it registers.
ALTER TABLE suppliers ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE suppliers ALTER COLUMN email DROP NOT NULL;
ALTER TABLE financier_profiles ADD COLUMN IF NOT EXISTS funder_type varchar;
ALTER TABLE financier_profiles ADD COLUMN IF NOT EXISTS regulatory_status varchar;
ALTER TABLE financier_profiles ADD COLUMN IF NOT EXISTS licence_reference varchar;
ALTER TABLE financier_profiles ADD COLUMN IF NOT EXISTS tax_status varchar;
ALTER TABLE financier_profiles ADD COLUMN IF NOT EXISTS custodian_may_approve boolean NOT NULL DEFAULT false;
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS erp_system varchar;

-- ── organisation lifecycle (§13.5.11, §13.6, §13.7.10) ───────────────────────
CREATE TABLE IF NOT EXISTS organisation_lifecycle (
  org_ref varchar PRIMARY KEY,
  counterparty varchar NOT NULL CHECK (counterparty IN ('ANCHOR','FUNDER','SUPPLIER')),
  status varchar NOT NULL,
  legacy boolean NOT NULL DEFAULT false,
  risk_rating varchar CHECK (risk_rating IS NULL OR risk_rating IN ('low','medium','high')),
  re_verification_due date,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS organisation_status_events (
  id bigserial PRIMARY KEY,
  org_ref varchar NOT NULL,
  previous_status varchar,
  new_status varchar NOT NULL,
  actor_id bigint REFERENCES users(id),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS organisation_status_events_ref_idx ON organisation_status_events(org_ref, id);
DROP TRIGGER IF EXISTS organisation_status_events_append_only ON organisation_status_events;
CREATE TRIGGER organisation_status_events_append_only BEFORE UPDATE OR DELETE ON organisation_status_events FOR EACH ROW EXECUTE FUNCTION refuse_financial_mutation();
-- Organisations already on the platform keep working: they are recorded as active, set up before this process.
INSERT INTO organisation_lifecycle(org_ref,counterparty,status,legacy) SELECT 'buyer-'||id,'ANCHOR',CASE WHEN archived_at IS NULL THEN 'ACTIVE' ELSE 'SUSPENDED' END,true FROM buyers ON CONFLICT DO NOTHING;
INSERT INTO organisation_lifecycle(org_ref,counterparty,status,legacy) SELECT 'financier-'||user_id,'FUNDER',CASE WHEN archived_at IS NULL THEN 'ACTIVE' ELSE 'SUSPENDED' END,true FROM financier_profiles ON CONFLICT DO NOTHING;
INSERT INTO organisation_lifecycle(org_ref,counterparty,status,legacy) SELECT 'supplier-'||id,'SUPPLIER',CASE WHEN archived_at IS NULL THEN 'ACTIVE' ELSE 'SUSPENDED' END,true FROM suppliers ON CONFLICT DO NOTHING;

-- ── executed agreements (set-up gate A1.1/F1.1; captured in full at A3/F3) ─────
CREATE TABLE IF NOT EXISTS executed_agreements (
  id bigserial PRIMARY KEY,
  org_ref varchar NOT NULL,
  kind varchar NOT NULL CHECK (kind IN ('commercial','facility')),
  version integer NOT NULL DEFAULT 1,
  reference varchar(200) NOT NULL,
  executed_on date NOT NULL,
  effective_on date,
  expiry_on date,
  document_ids jsonb NOT NULL DEFAULT '[]',
  terms jsonb NOT NULL DEFAULT '{}',
  status varchar NOT NULL DEFAULT 'in_force' CHECK (status IN ('in_force','superseded')),
  captured_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_ref, kind, version),
  CHECK (expiry_on IS NULL OR effective_on IS NULL OR expiry_on >= effective_on)
);

-- ── signatories and purpose contacts (A1.4, A1.5, F1.4) ─────────────────────
CREATE TABLE IF NOT EXISTS authorised_signatories (
  id bigserial PRIMARY KEY,
  org_ref varchar NOT NULL,
  name varchar(200) NOT NULL,
  title varchar(200),
  email varchar(254),
  scope text NOT NULL,
  authority_limit numeric(20,2),
  evidence_document_id bigint REFERENCES documents(id),
  evidence_clause varchar(200),
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);
CREATE INDEX IF NOT EXISTS authorised_signatories_ref_idx ON authorised_signatories(org_ref);
CREATE TABLE IF NOT EXISTS organisation_contacts (
  org_ref varchar NOT NULL,
  purpose varchar NOT NULL CHECK (purpose IN ('commercial','finance','it','operations')),
  name varchar(200) NOT NULL,
  email varchar(254),
  phone varchar(100),
  updated_by bigint REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_ref, purpose)
);

-- ── invitations (released at A4.9/F3.5; supplier invitations at S1) ──────────
CREATE TABLE IF NOT EXISTS user_invitations (
  id bigserial PRIMARY KEY,
  token_hash varchar(64) NOT NULL UNIQUE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_ref varchar NOT NULL,
  invited_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz
);
CREATE INDEX IF NOT EXISTS user_invitations_user_idx ON user_invitations(user_id);

-- ── programme link per supplier (S1.4 PENDING_ENROLMENT → S3.5 ENROLLED) ─────
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS financing_model varchar NOT NULL DEFAULT 'tender';
ALTER TABLE programmes DROP CONSTRAINT IF EXISTS programmes_financing_model_check;
ALTER TABLE programmes ADD CONSTRAINT programmes_financing_model_check CHECK (financing_model IN ('early_payment','tender'));
CREATE TABLE IF NOT EXISTS programme_enrolments (
  programme_id bigint NOT NULL REFERENCES programmes(id),
  supplier_id bigint NOT NULL REFERENCES suppliers(id),
  status varchar NOT NULL DEFAULT 'PENDING_ENROLMENT' CHECK (status IN ('PENDING_ENROLMENT','ENROLLED','SUSPENDED')),
  invited_by bigint REFERENCES users(id),
  channel varchar CHECK (channel IS NULL OR channel IN ('email','sms','existing')),
  delivery_status varchar,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (programme_id, supplier_id)
);
-- Suppliers already on programmes keep transacting.
INSERT INTO programme_enrolments(programme_id,supplier_id,status,channel) SELECT programme_id,supplier_id,'ENROLLED','existing' FROM portal_programme_suppliers ON CONFLICT DO NOTHING;

-- ── configuration, not code (§13.4) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS onboarding_settings (
  key varchar PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by bigint REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO onboarding_settings(key,value) VALUES
  ('invitation_validity_days','{"ANCHOR":7,"FUNDER":14,"SUPPLIER":7}'),
  ('required_user_roles','{"ANCHOR":["administrator","approver"],"FUNDER":["credit_officer"],"SUPPLIER":["administrator"]}')
ON CONFLICT DO NOTHING;
