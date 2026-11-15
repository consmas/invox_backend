-- SRS Appendix B, increment 2 (A2, F1.3/F1.7–F1.8, S2): the compliance gate.
-- The checklist is configuration by counterparty, country and tier; documents are filed against it with issue and
-- expiry dates; beneficial ownership is structured; every party is screened (provider-agnostic, 'manual' for now);
-- bank accounts are verified by a second person with a cool-off before first use; a compliance officer who did not
-- submit the file signs it off, refers it back with itemised gaps, or declines it.

CREATE TABLE IF NOT EXISTS compliance_checklist_items (
  id bigserial PRIMARY KEY,
  counterparty varchar NOT NULL CHECK (counterparty IN ('ANCHOR','FUNDER','SUPPLIER')),
  country varchar NOT NULL DEFAULT '*',
  tier varchar NOT NULL DEFAULT 'standard' CHECK (tier IN ('standard','simplified','full')),
  item_key varchar NOT NULL,
  label varchar NOT NULL,
  guidance text,
  expires boolean NOT NULL DEFAULT false,
  sort integer NOT NULL DEFAULT 0,
  UNIQUE (counterparty, country, tier, item_key)
);
INSERT INTO compliance_checklist_items(counterparty,country,tier,item_key,label,guidance,expires,sort) VALUES
 ('ANCHOR','*','standard','incorporation','Certificate of incorporation','Issued by the companies registry',false,1),
 ('ANCHOR','*','standard','constitution','Constitution or regulations','Current constitutional document',false,2),
 ('ANCHOR','*','standard','registered_address','Proof of registered address','Dated within the last three months',true,3),
 ('ANCHOR','*','standard','board_resolution','Board resolution or authority to transact','Authorising the programme and its signatories',false,4),
 ('ANCHOR','*','standard','financial_statements','Financial statements','Most recent audited accounts',true,5),
 ('ANCHOR','*','standard','individual_ids','Identification of directors and beneficial owners','One file per individual or a combined pack',true,6),
 ('FUNDER','*','standard','incorporation','Certificate of incorporation','Issued by the companies registry',false,1),
 ('FUNDER','*','standard','constitution','Constitutional documents','',false,2),
 ('FUNDER','*','standard','regulatory_licence','Regulatory licence','Evidence of regulatory standing',true,3),
 ('FUNDER','*','standard','signatory_authority','Authorised signatory list and evidence of authority','Including who may commit capital and to what value',false,4),
 ('FUNDER','*','standard','ownership_structure','Ownership and control structure','',false,5),
 ('FUNDER','*','standard','source_of_funds','Source-of-funds declaration','',false,6),
 ('FUNDER','*','standard','tax_documentation','Tax documentation','',true,7),
 ('SUPPLIER','*','simplified','incorporation','Certificate of incorporation or business registration','A photo of the certificate is fine',false,1),
 ('SUPPLIER','*','simplified','individual_ids','Identification of each director','Ghana Card or passport',true,2),
 ('SUPPLIER','*','full','incorporation','Certificate of incorporation or business registration','A photo of the certificate is fine',false,1),
 ('SUPPLIER','*','full','individual_ids','Identification of each director and beneficial owner','Ghana Card or passport',true,2),
 ('SUPPLIER','*','full','tax_certificate','Tax identification certificate','Showing the company TIN',false,3),
 ('SUPPLIER','*','full','registered_address','Proof of business address','Utility bill or tenancy agreement, last three months',true,4)
ON CONFLICT DO NOTHING;

ALTER TABLE organisation_lifecycle ADD COLUMN IF NOT EXISTS tier varchar NOT NULL DEFAULT 'standard';
ALTER TABLE organisation_lifecycle DROP CONSTRAINT IF EXISTS organisation_lifecycle_tier_check;
ALTER TABLE organisation_lifecycle ADD CONSTRAINT organisation_lifecycle_tier_check CHECK (tier IN ('standard','simplified','full'));
UPDATE organisation_lifecycle SET tier='simplified' WHERE counterparty='SUPPLIER' AND tier='standard';

CREATE TABLE IF NOT EXISTS compliance_documents (
  id bigserial PRIMARY KEY,
  org_ref varchar NOT NULL,
  item_key varchar NOT NULL,
  document_id bigint NOT NULL REFERENCES documents(id),
  issued_on date,
  expires_on date,
  filed_by bigint NOT NULL REFERENCES users(id),
  filed_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on)
);
CREATE INDEX IF NOT EXISTS compliance_documents_ref_idx ON compliance_documents(org_ref) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS beneficial_owners (
  id bigserial PRIMARY KEY,
  org_ref varchar NOT NULL,
  parent_id bigint REFERENCES beneficial_owners(id),
  kind varchar NOT NULL CHECK (kind IN ('natural','entity')),
  name varchar(200) NOT NULL,
  nationality varchar(2),
  date_of_birth date,
  ownership_percent numeric(7,4) CHECK (ownership_percent IS NULL OR (ownership_percent >= 0 AND ownership_percent <= 100)),
  is_director boolean NOT NULL DEFAULT false,
  evidence_document_id bigint REFERENCES documents(id),
  recorded_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  CHECK (kind = 'natural' OR NOT is_director)
);
CREATE INDEX IF NOT EXISTS beneficial_owners_ref_idx ON beneficial_owners(org_ref) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS party_screenings (
  id bigserial PRIMARY KEY,
  org_ref varchar NOT NULL,
  subject_type varchar NOT NULL CHECK (subject_type IN ('organisation','individual','signatory')),
  subject_name varchar(200) NOT NULL,
  provider varchar NOT NULL DEFAULT 'manual',
  lists jsonb NOT NULL DEFAULT '["sanctions","pep","adverse_media"]',
  outcome varchar NOT NULL CHECK (outcome IN ('clear','potential_match','confirmed_match')),
  reference varchar(200),
  payload jsonb NOT NULL DEFAULT '{}',
  recorded_by bigint NOT NULL REFERENCES users(id),
  screened_at timestamptz NOT NULL DEFAULT now(),
  resolution varchar CHECK (resolution IS NULL OR resolution IN ('false_positive','confirmed')),
  resolution_note text,
  resolved_by bigint REFERENCES users(id),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS party_screenings_ref_idx ON party_screenings(org_ref);

CREATE TABLE IF NOT EXISTS settlement_accounts (
  id bigserial PRIMARY KEY,
  org_ref varchar NOT NULL,
  purpose varchar NOT NULL CHECK (purpose IN ('collection','settlement','payout')),
  bank_name varchar(200) NOT NULL,
  bank_code varchar(50),
  account_number varchar(40) NOT NULL,
  account_name varchar(200) NOT NULL,
  currency varchar(3) NOT NULL,
  evidence_document_id bigint NOT NULL REFERENCES documents(id),
  name_check varchar NOT NULL DEFAULT 'not_available' CHECK (name_check IN ('match','mismatch','not_available')),
  status varchar NOT NULL DEFAULT 'PENDING_VERIFICATION' CHECK (status IN ('PENDING_VERIFICATION','VERIFIED','REJECTED','SUPERSEDED')),
  authorised_by_signatory_id bigint REFERENCES authorised_signatories(id),
  replaces_id bigint REFERENCES settlement_accounts(id),
  recorded_by bigint NOT NULL REFERENCES users(id),
  verified_by bigint REFERENCES users(id),
  verified_at timestamptz,
  usable_from timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'VERIFIED' OR (verified_by IS NOT NULL AND verified_by <> recorded_by AND usable_from IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS settlement_accounts_ref_idx ON settlement_accounts(org_ref);
CREATE UNIQUE INDEX IF NOT EXISTS one_live_account_per_purpose ON settlement_accounts(org_ref, purpose, currency) WHERE status = 'VERIFIED';

CREATE TABLE IF NOT EXISTS compliance_reviews (
  id bigserial PRIMARY KEY,
  org_ref varchar NOT NULL,
  submitted_by bigint NOT NULL REFERENCES users(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  snapshot jsonb NOT NULL DEFAULT '{}',
  decision varchar CHECK (decision IS NULL OR decision IN ('signed_off','referred','declined')),
  decided_by bigint REFERENCES users(id),
  decided_at timestamptz,
  risk_rating varchar CHECK (risk_rating IS NULL OR risk_rating IN ('low','medium','high')),
  outstanding_items jsonb NOT NULL DEFAULT '[]',
  note text,
  CHECK (decided_by IS NULL OR decided_by <> submitted_by)
);
CREATE INDEX IF NOT EXISTS compliance_reviews_ref_idx ON compliance_reviews(org_ref, id);

INSERT INTO onboarding_settings(key,value) VALUES
  ('beneficial_owner_threshold_percent','25'),
  ('account_cool_off_days','3'),
  ('re_verification_months','{"low":36,"medium":24,"high":12}'),
  ('supplier_default_tier','"simplified"')
ON CONFLICT DO NOTHING;
