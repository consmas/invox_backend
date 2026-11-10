-- Additive field coverage. Existing data is preserved; new facts are not inferred.
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS "legal_name" varchar(500);
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS "trading_name" varchar(500);
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS "country" varchar(2);
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS "industry" varchar(500);
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS "registered_address" varchar(500);
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS "operating_address" varchar(500);
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS "contact_name" varchar(500);
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS "contact_phone" varchar(500);
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS "website" varchar(500);
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS "tax_id" varchar(500);
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS "vat_number" varchar(500);
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS "preferred_currency" varchar(3);
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS "preferred_language" varchar(500);
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS "verification_status" varchar(500);
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS "approval_status" varchar(500);
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS "risk_rating" varchar(500);
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS "last_verified_at" timestamptz;
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS "next_review_date" date;
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS "screening_status" varchar(500);
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS "onboarding_status" varchar(500);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS "legal_name" varchar(500);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS "trading_name" varchar(500);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS "registration_number" varchar(500);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS "country" varchar(2);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS "industry" varchar(500);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS "registered_address" varchar(500);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS "operating_address" varchar(500);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS "contact_name" varchar(500);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS "contact_phone" varchar(500);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS "website" varchar(500);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS "tax_id" varchar(500);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS "vat_number" varchar(500);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS "preferred_currency" varchar(3);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS "preferred_language" varchar(500);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS "verification_status" varchar(500);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS "approval_status" varchar(500);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS "risk_rating" varchar(500);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS "last_verified_at" timestamptz;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS "next_review_date" date;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS "screening_status" varchar(500);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS "onboarding_status" varchar(500);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS "withholding_tax_rate" numeric(12,6);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS "vat_registered" boolean;
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "programme_reference" varchar(500);
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "description" varchar(500);
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "currency" varchar(3);
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "payment_terms" varchar(500);
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "maximum_tenor_days" integer;
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "discount_type" varchar(30);
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "day_count_basis" varchar(10);
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "margin_rate" numeric(12,6);
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "platform_fee_rate" numeric(12,6);
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "supplier_fee_rate" numeric(12,6);
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "funder_fee_rate" numeric(12,6);
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "dilution_cap_percent" numeric(12,6);
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "buyer_acceptance_authority" varchar(30);
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "allocation_policy" varchar(30);
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "governing_law" varchar(500);
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "jurisdiction" varchar(500);
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "agreement_reference" varchar(500);
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "agreement_document_id" bigint;
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "agreement_effective_date" date;
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "agreement_expiry_date" date;
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "review_date" date;
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "termination_notice_days" integer;
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "financing_eligibility_criteria" text;
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "risk_disclosures" text;
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "identity_disclosure_consent" boolean;
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "status" varchar(500);
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "effective_from" date;
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "effective_to" date;
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "version" integer;
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "configured_by" bigint;
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS "released_by" bigint;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS "issue_date" date;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS "payment_terms" varchar(500);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS "financing_eligible" boolean;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS "eligibility_reason" text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS "financing_amount_requested" numeric(18,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS "purchase_order_reference" varchar(500);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS "delivery_reference" varchar(500);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS "industry" varchar(500);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS "country" varchar(2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS "tax_amount" numeric(18,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS "vat_amount" numeric(18,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS "payment_reference" varchar(500);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS "supporting_documents" jsonb;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS "risk_disclosures" text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS "invoice_approval_status" varchar(500);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS "submitted_for_approval_at" timestamptz;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS "supplier_approved_at" timestamptz;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS "supplier_approved_by" bigint;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS "rejection_reason" text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS "clarification_request" text;
ALTER TABLE bids ADD COLUMN IF NOT EXISTS "currency" varchar(3);
ALTER TABLE bids ADD COLUMN IF NOT EXISTS "discount_type" varchar(30);
ALTER TABLE bids ADD COLUMN IF NOT EXISTS "discount_rate" numeric(12,6);
ALTER TABLE bids ADD COLUMN IF NOT EXISTS "discount_fee" numeric(18,2);
ALTER TABLE bids ADD COLUMN IF NOT EXISTS "other_fees" numeric(18,2);
ALTER TABLE bids ADD COLUMN IF NOT EXISTS "day_count_basis" varchar(10);
ALTER TABLE bids ADD COLUMN IF NOT EXISTS "expires_at" timestamptz;
ALTER TABLE bids ADD COLUMN IF NOT EXISTS "payment_timing" varchar(500);
ALTER TABLE bids ADD COLUMN IF NOT EXISTS "additional_conditions" text;
ALTER TABLE bids ADD COLUMN IF NOT EXISTS "requested_financing_amount" numeric(18,2);
ALTER TABLE bids ADD COLUMN IF NOT EXISTS "net_supplier_proceeds" numeric(18,2);
ALTER TABLE bids ADD COLUMN IF NOT EXISTS "submitted_at" timestamptz;
ALTER TABLE bids ADD COLUMN IF NOT EXISTS "pricing_snapshot" jsonb;
ALTER TABLE financing_agreements ADD COLUMN IF NOT EXISTS "agreement_reference" varchar(500);
ALTER TABLE financing_agreements ADD COLUMN IF NOT EXISTS "document_id" bigint;
ALTER TABLE financing_agreements ADD COLUMN IF NOT EXISTS "governing_law" varchar(500);
ALTER TABLE financing_agreements ADD COLUMN IF NOT EXISTS "jurisdiction" varchar(500);
ALTER TABLE financing_agreements ADD COLUMN IF NOT EXISTS "recourse_type" varchar(500);
ALTER TABLE financing_agreements ADD COLUMN IF NOT EXISTS "assignment_reference" varchar(500);
ALTER TABLE financing_agreements ADD COLUMN IF NOT EXISTS "template_version" varchar(500);
ALTER TABLE financing_agreements ADD COLUMN IF NOT EXISTS "key_terms_language" varchar(500);
ALTER TABLE financing_agreements ADD COLUMN IF NOT EXISTS "key_terms_acknowledged_at" timestamptz;
ALTER TABLE financing_agreements ADD COLUMN IF NOT EXISTS "accepted_at" timestamptz;
ALTER TABLE fundings ADD COLUMN IF NOT EXISTS "funding_reference" varchar(500);
ALTER TABLE fundings ADD COLUMN IF NOT EXISTS "value_date" date;
ALTER TABLE fundings ADD COLUMN IF NOT EXISTS "bank_confirmation_reference" varchar(500);
ALTER TABLE fundings ADD COLUMN IF NOT EXISTS "payment_provider" varchar(500);
ALTER TABLE fundings ADD COLUMN IF NOT EXISTS "bank_reason_code" varchar(500);
ALTER TABLE fundings ADD COLUMN IF NOT EXISTS "gross_invoice_amount" numeric(18,2);
ALTER TABLE fundings ADD COLUMN IF NOT EXISTS "financed_amount" numeric(18,2);
ALTER TABLE fundings ADD COLUMN IF NOT EXISTS "discount_amount" numeric(18,2);
ALTER TABLE fundings ADD COLUMN IF NOT EXISTS "other_charges" numeric(18,2);
ALTER TABLE repayments ADD COLUMN IF NOT EXISTS "value_date" date;
ALTER TABLE repayments ADD COLUMN IF NOT EXISTS "allocation_reference" varchar(500);
ALTER TABLE repayments ADD COLUMN IF NOT EXISTS "reconciliation_reference" varchar(500);
ALTER TABLE repayments ADD COLUMN IF NOT EXISTS "bank_confirmation_reference" varchar(500);
ALTER TABLE repayments ADD COLUMN IF NOT EXISTS "payment_provider" varchar(500);
ALTER TABLE repayments ADD COLUMN IF NOT EXISTS "bank_reason_code" varchar(500);
ALTER TABLE repayments ADD COLUMN IF NOT EXISTS "outstanding_balance" numeric(18,2);
CREATE TABLE financier_profiles (id bigserial PRIMARY KEY,user_id bigint NOT NULL UNIQUE REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE financier_profiles ADD COLUMN "name" varchar(500);
ALTER TABLE financier_profiles ADD COLUMN "legal_name" varchar(500);
ALTER TABLE financier_profiles ADD COLUMN "trading_name" varchar(500);
ALTER TABLE financier_profiles ADD COLUMN "registration_number" varchar(500);
ALTER TABLE financier_profiles ADD COLUMN "country" varchar(2);
ALTER TABLE financier_profiles ADD COLUMN "industry" varchar(500);
ALTER TABLE financier_profiles ADD COLUMN "registered_address" varchar(500);
ALTER TABLE financier_profiles ADD COLUMN "operating_address" varchar(500);
ALTER TABLE financier_profiles ADD COLUMN "contact_name" varchar(500);
ALTER TABLE financier_profiles ADD COLUMN "contact_email" varchar(254);
ALTER TABLE financier_profiles ADD COLUMN "contact_phone" varchar(500);
ALTER TABLE financier_profiles ADD COLUMN "website" varchar(500);
ALTER TABLE financier_profiles ADD COLUMN "tax_id" varchar(500);
ALTER TABLE financier_profiles ADD COLUMN "vat_number" varchar(500);
ALTER TABLE financier_profiles ADD COLUMN "preferred_currency" varchar(3);
ALTER TABLE financier_profiles ADD COLUMN "preferred_language" varchar(500);
ALTER TABLE financier_profiles ADD COLUMN "institution_type" varchar(500);
ALTER TABLE financier_profiles ADD COLUMN "verification_status" varchar(500);
ALTER TABLE financier_profiles ADD COLUMN "approval_status" varchar(500);
ALTER TABLE financier_profiles ADD COLUMN "risk_rating" varchar(500);
ALTER TABLE financier_profiles ADD COLUMN "last_verified_at" timestamptz;
ALTER TABLE financier_profiles ADD COLUMN "next_review_date" date;
ALTER TABLE financier_profiles ADD COLUMN "screening_status" varchar(500);
ALTER TABLE financier_profiles ADD COLUMN "onboarding_status" varchar(500);
ALTER TABLE financier_profiles ADD COLUMN "facility_limit" numeric(18,2);
ALTER TABLE financier_profiles ADD COLUMN "facility_currency" varchar(3);
ALTER TABLE financier_profiles ADD COLUMN "facility_start_date" date;
ALTER TABLE financier_profiles ADD COLUMN "facility_end_date" date;
ALTER TABLE financier_profiles ADD COLUMN "settlement_terms" varchar(500);
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enrolled_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_verified_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_successful_login_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS dormancy_suspended_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_recertified_at timestamptz;
CREATE TABLE organizations (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "name" varchar(500) NOT NULL,
  "legal_name" varchar(500) NOT NULL,
  "organization_type" varchar(30) NOT NULL CHECK ("organization_type" IN ('buyer','supplier','financier','platform')),
  "registration_number" varchar(500) NOT NULL,
  "country" varchar(2) NOT NULL,
  "contact_email" varchar(254) NOT NULL,
  "contact_phone" varchar(500),
  "address" varchar(500),
  "tax_id" varchar(500),
  "website" varchar(500),
  "preferred_language" varchar(500),
  "onboarding_status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE organization_memberships (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "organization_id" bigint NOT NULL,
  "user_id" bigint NOT NULL,
  "role_id" bigint NOT NULL,
  "starts_at" timestamptz,
  "expires_at" timestamptz,
  "status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE roles (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "name" varchar(500) NOT NULL,
  "description" text,
  "scope" varchar(500) NOT NULL
);
CREATE TABLE permissions (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "code" varchar(500) NOT NULL,
  "name" varchar(500) NOT NULL,
  "description" text,
  "action" varchar(500) NOT NULL,
  "resource" varchar(500) NOT NULL
);
CREATE TABLE role_permissions (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "role_id" bigint NOT NULL,
  "permission_id" bigint NOT NULL
);
CREATE TABLE sod_rules (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "role_a" bigint NOT NULL,
  "role_b" bigint NOT NULL,
  "scope" varchar(500) NOT NULL,
  "severity" varchar(500) NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date
);
CREATE TABLE sod_exceptions (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "user_id" bigint NOT NULL,
  "rule_id" bigint NOT NULL,
  "justification" text NOT NULL,
  "approver_id" bigint,
  "second_approver_id" bigint,
  "expires_at" timestamptz NOT NULL,
  "status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE invitations (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "supplier_id" bigint NOT NULL,
  "contact_email" varchar(254) NOT NULL,
  "contact_msisdn" varchar(500) NOT NULL,
  "issued_by" bigint,
  "issued_at" timestamptz,
  "expires_at" timestamptz,
  "consumed_at" timestamptz,
  "consumed_ip" varchar(500),
  "device_fingerprint" varchar(500),
  "status" varchar(500),
  "delivery_result" text,
  "reissue_reason" text
);
CREATE TABLE recertification_campaigns (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "organization_id" bigint NOT NULL,
  "reviewer_id" bigint NOT NULL,
  "starts_on" date NOT NULL,
  "due_on" date NOT NULL,
  "completed_at" timestamptz,
  "status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE recertification_responses (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "campaign_id" bigint NOT NULL,
  "user_id" bigint NOT NULL,
  "reviewer_id" bigint,
  "decision" varchar(500),
  "reason" text NOT NULL,
  "completed_at" timestamptz
);
CREATE TABLE auth_events (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "user_id" bigint NOT NULL,
  "result" varchar(500),
  "ip" varchar(500),
  "asn" varchar(500),
  "geo" varchar(500),
  "device_fingerprint" varchar(500),
  "risk_score" integer,
  "occurred_at" timestamptz
);
CREATE TABLE protected_action_policies (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "action_code" varchar(500) NOT NULL,
  "assurance_level" varchar(500) NOT NULL,
  "challenge_max_age_seconds" integer NOT NULL,
  "effective_from" date NOT NULL
);
CREATE TABLE privileged_access_requests (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "user_id" bigint NOT NULL,
  "purpose" text NOT NULL,
  "scope" varchar(500) NOT NULL,
  "requested_until" timestamptz NOT NULL,
  "approver_id" bigint,
  "second_approver_id" bigint,
  "session_recording_reference" varchar(500),
  "granted_at" timestamptz,
  "revoked_at" timestamptz,
  "status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE onboarding_requirements (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "counterparty_type" varchar(30) NOT NULL CHECK ("counterparty_type" IN ('buyer','supplier','financier','platform')),
  "jurisdiction" varchar(500) NOT NULL,
  "artefact_type" varchar(500) NOT NULL,
  "mandatory" boolean NOT NULL,
  "validity_days" integer NOT NULL
);
CREATE TABLE counterparty_artefacts (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "organization_id" bigint NOT NULL,
  "requirement_id" bigint NOT NULL,
  "document_id" bigint NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "verification_source" varchar(500),
  "verified_by" bigint,
  "verified_at" timestamptz,
  "status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE ubo_records (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "organization_id" bigint NOT NULL,
  "full_name" varchar(500) NOT NULL,
  "date_of_birth" date,
  "nationality" varchar(2),
  "ownership_percentage" numeric(12,6) NOT NULL,
  "identifier_reference" varchar(500) NOT NULL,
  "verification_source" varchar(500),
  "verified_by" bigint,
  "verified_at" timestamptz
);
CREATE TABLE screening_subjects (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "organization_id" bigint NOT NULL,
  "subject_type" varchar(500) NOT NULL,
  "full_name" varchar(500) NOT NULL,
  "date_of_birth" date,
  "nationality" varchar(2),
  "identifiers" jsonb
);
CREATE TABLE screening_runs (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "provider" varchar(500) NOT NULL,
  "list_version" varchar(500) NOT NULL,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE screening_results (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "subject_id" bigint NOT NULL,
  "run_id" bigint NOT NULL,
  "list_name" varchar(500) NOT NULL,
  "score" numeric(12,6),
  "match_status" varchar(500),
  "reviewer_id" bigint,
  "disposition" text,
  "reviewed_at" timestamptz,
  "evidence_id" bigint
);
CREATE TABLE refresh_schedules (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "organization_id" bigint NOT NULL,
  "risk_rating" varchar(500) NOT NULL,
  "cycle_months" integer NOT NULL,
  "next_due" date NOT NULL,
  "status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE source_verifications (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "organization_id" bigint NOT NULL,
  "verification_type" varchar(500) NOT NULL,
  "source_name" varchar(500) NOT NULL,
  "source_reference" varchar(500) NOT NULL,
  "requested_at" timestamptz,
  "result" jsonb,
  "verified_by" bigint,
  "verified_at" timestamptz,
  "status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE related_party_matches (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "buyer_id" bigint NOT NULL,
  "supplier_id" bigint NOT NULL,
  "match_type" varchar(500) NOT NULL,
  "evidence" text NOT NULL,
  "reviewer_id" bigint,
  "disposition" text,
  "reviewed_at" timestamptz,
  "status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE conditions_precedent (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "programme_id" bigint NOT NULL,
  "description" text NOT NULL,
  "owner_id" bigint NOT NULL,
  "mandatory" boolean NOT NULL,
  "due_date" date NOT NULL,
  "evidence_id" bigint,
  "satisfied_at" timestamptz,
  "waived_by" bigint,
  "waiver_expiry" timestamptz,
  "status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE documents (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "organization_id" bigint,
  "buyer_id" bigint,
  "supplier_id" bigint,
  "invoice_id" bigint,
  "category" varchar(500) NOT NULL,
  "file_name" varchar(500) NOT NULL,
  "mime_type" varchar(500) NOT NULL,
  "size_bytes" integer NOT NULL,
  "storage_key" varchar(500) NOT NULL,
  "sha256" varchar(64) NOT NULL,
  "version" integer DEFAULT 1,
  "retention_until" date,
  "legal_hold" boolean,
  "scan_status" varchar(500) DEFAULT 'pending',
  "upload_status" varchar(500) DEFAULT 'pending',
  "verified_by" bigint,
  "verified_at" timestamptz
);
CREATE TABLE jurisdictions (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "country" varchar(2) NOT NULL,
  "governing_law" varchar(500) NOT NULL,
  "legal_opinion_document_id" bigint NOT NULL,
  "opinion_date" date NOT NULL,
  "expires_on" date NOT NULL,
  "notice_requirements" text,
  "insolvency_treatment" text,
  "reviewed_by" bigint,
  "status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE agreement_amendments (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "programme_id" bigint NOT NULL,
  "document_id" bigint NOT NULL,
  "reason" text NOT NULL,
  "effective_date" date NOT NULL,
  "before_values" jsonb NOT NULL,
  "after_values" jsonb NOT NULL,
  "released_by" bigint,
  "released_at" timestamptz,
  "status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE key_terms_summaries (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "language" varchar(500) NOT NULL,
  "content" text NOT NULL,
  "template_version" varchar(500) NOT NULL,
  "version" integer NOT NULL,
  "effective_from" date NOT NULL,
  "legal_approved_by" bigint,
  "legal_approved_at" timestamptz,
  "status" varchar(500) DEFAULT 'draft'
);
CREATE TABLE summary_acknowledgements (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "supplier_id" bigint NOT NULL,
  "summary_id" bigint NOT NULL,
  "user_id" bigint,
  "acknowledged_at" timestamptz,
  "ip" varchar(500),
  "dwell_seconds" integer
);
CREATE TABLE transfer_instruments (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "invoice_id" bigint NOT NULL,
  "financier_id" bigint NOT NULL,
  "instrument_type" varchar(500) NOT NULL,
  "template_version" varchar(500) NOT NULL,
  "document_id" bigint,
  "jurisdiction" varchar(500) NOT NULL,
  "generated_at" timestamptz,
  "signature_status" varchar(500),
  "signature_evidence_reference" varchar(500),
  "document_hash" varchar(500)
);
CREATE TABLE invoice_batches (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "buyer_id" bigint NOT NULL,
  "source_system" varchar(500) NOT NULL,
  "source_reference" varchar(500) NOT NULL,
  "batch_hash" varchar(500) NOT NULL,
  "expected_count" integer NOT NULL,
  "expected_total" numeric(18,2) NOT NULL CHECK ("expected_total" >= 0),
  "currency" varchar(3) NOT NULL CHECK ("currency" IN ('GHS','USD','EUR')),
  "signature_reference" varchar(500),
  "received_count" integer,
  "received_total" numeric(18,2) CHECK ("received_total" >= 0),
  "received_at" timestamptz,
  "reconciled_at" timestamptz,
  "status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE ingestion_exceptions (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "batch_id" bigint NOT NULL,
  "invoice_id" bigint,
  "type" varchar(500) NOT NULL,
  "description" text NOT NULL,
  "owner_id" bigint NOT NULL,
  "due_at" timestamptz NOT NULL,
  "resolution" text,
  "resolved_by" bigint,
  "resolved_at" timestamptz,
  "status" varchar(500) DEFAULT 'open'
);
CREATE TABLE approval_warranties (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "invoice_id" bigint NOT NULL,
  "batch_id" bigint,
  "warranty_version" varchar(500) NOT NULL,
  "undisputed" boolean,
  "unpaid" boolean,
  "goods_received" boolean,
  "no_setoff" boolean,
  "statement_hash" varchar(500),
  "approved_by" bigint,
  "approved_at" timestamptz,
  "ip" varchar(500),
  "user_agent" varchar(500)
);
CREATE TABLE approval_requests (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "invoice_id" bigint NOT NULL,
  "request_type" varchar(500) NOT NULL,
  "requested_by" bigint,
  "assigned_to" bigint NOT NULL,
  "due_at" timestamptz NOT NULL,
  "reason" text,
  "decided_by" bigint,
  "decided_at" timestamptz,
  "decision" varchar(500),
  "status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE dilution_events (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "invoice_id" bigint NOT NULL,
  "type" varchar(500) NOT NULL,
  "amount" numeric(18,2) NOT NULL CHECK ("amount" > 0),
  "reason" text NOT NULL,
  "evidence_id" bigint NOT NULL,
  "raised_by" bigint,
  "allocation_result" jsonb,
  "status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE allocation_rules (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "programme_id" bigint NOT NULL,
  "waterfall_definition" jsonb NOT NULL,
  "cap_percentage" numeric(12,6) NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "version" integer,
  "approved_by" bigint,
  "status" varchar(500) DEFAULT 'draft'
);
CREATE TABLE financing_tenders (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "invoice_id" bigint NOT NULL,
  "programme_id" bigint NOT NULL,
  "tender_reference" varchar(500) NOT NULL,
  "currency" varchar(3) NOT NULL CHECK ("currency" IN ('GHS','USD','EUR')),
  "financing_amount_requested" numeric(18,2) NOT NULL CHECK ("financing_amount_requested" > 0),
  "opens_at" timestamptz NOT NULL,
  "closes_at" timestamptz NOT NULL,
  "maturity_date" date NOT NULL,
  "eligible_conditions" text NOT NULL,
  "risk_disclosures" text NOT NULL,
  "industry" varchar(500),
  "disclosure_policy_id" bigint,
  "published_by" bigint,
  "published_at" timestamptz,
  "status" varchar(500) DEFAULT 'draft'
);
CREATE TABLE programme_financiers (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "programme_id" bigint NOT NULL,
  "financier_id" bigint NOT NULL,
  "mandate_id" bigint,
  "facility_limit" numeric(18,2) NOT NULL CHECK ("facility_limit" > 0),
  "currency" varchar(3) NOT NULL CHECK ("currency" IN ('GHS','USD','EUR')),
  "starts_on" date NOT NULL,
  "expires_on" date NOT NULL,
  "accepted_by" bigint,
  "accepted_at" timestamptz,
  "status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE mandate_versions (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "financier_id" bigint NOT NULL,
  "name" varchar(500) NOT NULL,
  "parameters" jsonb,
  "permitted_countries" jsonb NOT NULL,
  "permitted_sectors" jsonb NOT NULL,
  "permitted_currencies" jsonb NOT NULL,
  "minimum_tenor_days" integer,
  "maximum_tenor_days" integer NOT NULL,
  "single_name_limit" numeric(18,2) CHECK ("single_name_limit" > 0),
  "sector_concentration_percent" numeric(12,6),
  "country_concentration_percent" numeric(12,6),
  "facility_limit" numeric(18,2) NOT NULL CHECK ("facility_limit" > 0),
  "plain_language_terms" text NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "version" integer,
  "status" varchar(500) DEFAULT 'draft'
);
CREATE TABLE mandate_acceptances (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "mandate_id" bigint NOT NULL,
  "accepted_by" bigint,
  "accepted_at" timestamptz,
  "ip" varchar(500),
  "evidence_hash" varchar(500)
);
CREATE TABLE mandate_tests (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "financier_id" bigint NOT NULL,
  "dimension" varchar(500) NOT NULL,
  "measure" varchar(500) NOT NULL,
  "threshold" numeric(18,2) NOT NULL CHECK ("threshold" >= 0),
  "classification" varchar(500) NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date
);
CREATE TABLE mandate_breaches (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "financier_id" bigint NOT NULL,
  "test_id" bigint NOT NULL,
  "measured_value" numeric(18,2) CHECK ("measured_value" >= 0),
  "cause" varchar(500) NOT NULL,
  "remedy_reference" varchar(500),
  "detected_at" timestamptz,
  "resolved_at" timestamptz,
  "status" varchar(500) DEFAULT 'open'
);
CREATE TABLE limits (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "scope_type" varchar(500) NOT NULL,
  "scope_id" varchar(500) NOT NULL,
  "limit_type" varchar(500) NOT NULL,
  "amount" numeric(18,2) NOT NULL CHECK ("amount" > 0),
  "currency" varchar(3) NOT NULL CHECK ("currency" IN ('GHS','USD','EUR')),
  "effective_from" date NOT NULL,
  "effective_to" date,
  "authority_reference" varchar(500) NOT NULL,
  "approved_by" bigint,
  "status" varchar(500) DEFAULT 'draft'
);
CREATE TABLE limit_reservations (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "request_id" bigint NOT NULL,
  "limit_id" bigint NOT NULL,
  "amount" numeric(18,2) NOT NULL CHECK ("amount" > 0),
  "reserved_at" timestamptz,
  "expires_at" timestamptz NOT NULL,
  "released_at" timestamptz,
  "release_reason" varchar(500),
  "status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE financing_requests (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "invoice_id" bigint NOT NULL,
  "supplier_id" bigint NOT NULL,
  "idempotency_key" varchar(500) NOT NULL,
  "requested_amount" numeric(18,2) NOT NULL CHECK ("requested_amount" > 0),
  "currency" varchar(3) NOT NULL CHECK ("currency" IN ('GHS','USD','EUR')),
  "requested_at" timestamptz,
  "submitted_by" bigint,
  "state_history" jsonb,
  "status" varchar(500) DEFAULT 'draft'
);
CREATE TABLE bank_accounts (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "organization_id" bigint NOT NULL,
  "supplier_id" bigint,
  "bank_name" varchar(500) NOT NULL,
  "bank_country" varchar(2) NOT NULL,
  "account_name" varchar(500) NOT NULL,
  "account_number" text NOT NULL,
  "branch_code" varchar(500),
  "swift_code" varchar(500),
  "iban" text,
  "currency" varchar(3) NOT NULL CHECK ("currency" IN ('GHS','USD','EUR')),
  "account_type" varchar(500),
  "account_name_verification_reference" varchar(500),
  "verified_by" bigint,
  "verified_at" timestamptz,
  "cooling_until" timestamptz,
  "snapshot_hash" varchar(500),
  "status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE funding_decisions (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "request_id" bigint NOT NULL,
  "invoice_id" bigint NOT NULL,
  "bank_account_id" bigint NOT NULL,
  "bank_snapshot" jsonb,
  "snapshot_hash" varchar(500),
  "decided_by" bigint,
  "decided_at" timestamptz,
  "status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE availability_snapshots (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "invoice_id" bigint NOT NULL,
  "tier" varchar(500),
  "basis" jsonb,
  "computed_at" timestamptz,
  "expires_at" timestamptz,
  "withdrawal_reason" varchar(500)
);
CREATE TABLE disclosure_policies (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "programme_id" bigint NOT NULL,
  "disclose_identity" boolean NOT NULL,
  "permitted_attributes" jsonb NOT NULL,
  "consent_document_id" bigint,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "approved_by" bigint,
  "status" varchar(500) DEFAULT 'draft'
);
CREATE TABLE allocation_algorithms (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "name" varchar(500) NOT NULL,
  "definition" jsonb NOT NULL,
  "weighting" jsonb NOT NULL,
  "tie_break_rule" varchar(500) NOT NULL,
  "version" integer,
  "effective_from" date NOT NULL,
  "approved_by" bigint,
  "status" varchar(500) DEFAULT 'draft'
);
CREATE TABLE allocation_decisions (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "invoice_id" bigint NOT NULL,
  "algorithm_id" bigint NOT NULL,
  "candidate_set" jsonb,
  "scores" jsonb,
  "selected_financier_id" bigint,
  "decided_at" timestamptz,
  "reason" text
);
CREATE TABLE marketplace_listings (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "invoice_id" bigint NOT NULL,
  "as_at" timestamptz,
  "attribute_snapshot" jsonb,
  "snapshot_hash" varchar(500),
  "expires_at" timestamptz NOT NULL,
  "status" varchar(500) DEFAULT 'draft'
);
CREATE TABLE acceptance_validations (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "listing_id" bigint NOT NULL,
  "revalidated_at" timestamptz,
  "changed_attributes" jsonb,
  "outcome" varchar(500)
);
CREATE TABLE funder_cash_positions (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "financier_id" bigint NOT NULL,
  "currency" varchar(3) NOT NULL CHECK ("currency" IN ('GHS','USD','EUR')),
  "cleared_balance" numeric(18,2) CHECK ("cleared_balance" >= 0),
  "pending_in" numeric(18,2) CHECK ("pending_in" >= 0),
  "reserved" numeric(18,2) CHECK ("reserved" >= 0),
  "as_at" timestamptz,
  "bank_evidence_reference" varchar(500) NOT NULL
);
CREATE TABLE intraday_facilities (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "financier_id" bigint NOT NULL,
  "limit" numeric(18,2) NOT NULL CHECK ("limit" > 0),
  "currency" varchar(3) NOT NULL CHECK ("currency" IN ('GHS','USD','EUR')),
  "board_authority_document_id" bigint NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date NOT NULL,
  "approved_by" bigint,
  "status" varchar(500) DEFAULT 'draft'
);
CREATE TABLE reference_rates (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "name" varchar(500) NOT NULL,
  "currency" varchar(3) NOT NULL CHECK ("currency" IN ('GHS','USD','EUR')),
  "tenor" varchar(500) NOT NULL,
  "primary_source" varchar(500) NOT NULL,
  "fallback_source" varchar(500) NOT NULL,
  "fixing_time" varchar(500) NOT NULL,
  "publication_calendar" varchar(500) NOT NULL
);
CREATE TABLE rate_fixings (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "rate_id" bigint NOT NULL,
  "value_date" date NOT NULL,
  "value" numeric(12,6),
  "source_used" varchar(500) NOT NULL,
  "ingested_at" timestamptz,
  "status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE rate_corrections (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "original_fixing_id" bigint NOT NULL,
  "corrected_fixing_id" bigint,
  "reason" text NOT NULL,
  "affected_transactions" jsonb,
  "remediation_decision" text,
  "approved_by" bigint,
  "status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE pricing_quotes (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "invoice_id" bigint NOT NULL,
  "reference_rate_id" bigint NOT NULL,
  "reference_rate_value" numeric(12,6),
  "rate_fixing_time" timestamptz,
  "margin" numeric(12,6),
  "fees" numeric(18,2) CHECK ("fees" >= 0),
  "computed_charge" numeric(18,2) CHECK ("computed_charge" >= 0),
  "quoted_at" timestamptz,
  "expires_at" timestamptz NOT NULL,
  "tolerance_bps" numeric(12,6) NOT NULL,
  "snapshot" jsonb,
  "status" varchar(500) DEFAULT 'draft'
);
CREATE TABLE fx_sources (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "currency_pair" varchar(500) NOT NULL,
  "provider" varchar(500) NOT NULL,
  "fixing_time" varchar(500) NOT NULL,
  "spread_policy" text NOT NULL,
  "tolerance_bps" numeric(12,6) NOT NULL
);
CREATE TABLE fx_snapshots (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "invoice_id" bigint NOT NULL,
  "source_id" bigint NOT NULL,
  "rate" numeric(24,8),
  "source_used" varchar(500),
  "fixed_at" timestamptz,
  "spread_applied" numeric(12,6)
);
CREATE TABLE effective_configurations (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "name" varchar(500) NOT NULL,
  "parameter_type" varchar(500) NOT NULL,
  "value" jsonb NOT NULL,
  "currency" varchar(500),
  "effective_from" date NOT NULL,
  "effective_to" date,
  "change_reason" text NOT NULL,
  "authority_document_id" bigint NOT NULL,
  "version" integer,
  "released_by" bigint,
  "status" varchar(500) DEFAULT 'draft'
);
CREATE TABLE standing_instructions (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "supplier_id" bigint NOT NULL,
  "programme_id" bigint NOT NULL,
  "scope" varchar(500) NOT NULL,
  "created_on" date,
  "expires_on" date NOT NULL,
  "renewal_history" jsonb,
  "accepted_by" bigint,
  "status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE supplier_statements (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "supplier_id" bigint NOT NULL,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "transaction_count" integer,
  "gross_financed" numeric(18,2) CHECK ("gross_financed" >= 0),
  "total_discount" numeric(18,2) CHECK ("total_discount" >= 0),
  "weighted_effective_rate" numeric(12,6),
  "generated_at" timestamptz,
  "delivered_at" timestamptz,
  "document_id" bigint
);
CREATE TABLE repayment_schedules (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "funding_id" bigint NOT NULL,
  "buyer_id" bigint NOT NULL,
  "financier_id" bigint NOT NULL,
  "due_date" date NOT NULL,
  "amount_due" numeric(18,2) NOT NULL CHECK ("amount_due" > 0),
  "currency" varchar(3) NOT NULL CHECK ("currency" IN ('GHS','USD','EUR')),
  "principal" numeric(18,2) CHECK ("principal" >= 0),
  "fees" numeric(18,2) CHECK ("fees" >= 0),
  "amount_received" numeric(18,2) CHECK ("amount_received" >= 0),
  "outstanding_balance" numeric(18,2) CHECK ("outstanding_balance" >= 0),
  "status" varchar(500) DEFAULT 'draft'
);
CREATE TABLE payment_transactions (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "invoice_id" bigint NOT NULL,
  "funding_id" bigint,
  "repayment_id" bigint,
  "instruction_reference" varchar(500) NOT NULL,
  "provider" varchar(500) NOT NULL,
  "payment_reference" varchar(500),
  "amount" numeric(18,2) NOT NULL CHECK ("amount" > 0),
  "currency" varchar(3) NOT NULL CHECK ("currency" IN ('GHS','USD','EUR')),
  "beneficiary_account_id" bigint,
  "idempotency_key" varchar(500) NOT NULL,
  "approved_by" bigint,
  "transmitted_at" timestamptz,
  "confirmation_reference" varchar(500),
  "confirmed_at" timestamptz,
  "bank_reason_code" varchar(500),
  "original_instruction_id" bigint,
  "status" varchar(500) DEFAULT 'draft'
);
CREATE TABLE collection_accounts (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "programme_id" bigint NOT NULL,
  "financier_id" bigint NOT NULL,
  "bank_account_id" bigint NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "approved_by" bigint,
  "cooling_until" timestamptz,
  "status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE misdirection_cases (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "invoice_id" bigint NOT NULL,
  "detected_at" timestamptz,
  "amount" numeric(18,2) NOT NULL CHECK ("amount" > 0),
  "currency" varchar(3) NOT NULL CHECK ("currency" IN ('GHS','USD','EUR')),
  "recovery_status" varchar(500),
  "recovery_owner_id" bigint NOT NULL,
  "escalated_at" timestamptz,
  "resolved_at" timestamptz,
  "evidence_id" bigint NOT NULL
);
CREATE TABLE payment_vouchers (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "programme_id" bigint NOT NULL,
  "batch_id" bigint NOT NULL,
  "voucher_reference" varchar(500) NOT NULL,
  "document_id" bigint NOT NULL,
  "schedule_hash" varchar(500),
  "control_count" integer,
  "control_total" numeric(18,2) CHECK ("control_total" >= 0),
  "currency" varchar(3) NOT NULL CHECK ("currency" IN ('GHS','USD','EUR')),
  "returned_hash" varchar(500),
  "captured_count" integer,
  "captured_total" numeric(18,2) CHECK ("captured_total" >= 0),
  "first_keyed_by" bigint,
  "second_keyed_by" bigint,
  "status" varchar(500) DEFAULT 'draft'
);
CREATE TABLE payment_files (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "file_reference" varchar(500) NOT NULL,
  "run_reference" varchar(500) NOT NULL,
  "document_id" bigint NOT NULL,
  "record_count" integer,
  "total_amount" numeric(18,2) CHECK ("total_amount" >= 0),
  "currency" varchar(3) NOT NULL CHECK ("currency" IN ('GHS','USD','EUR')),
  "content_hash" varchar(500),
  "approved_by" bigint,
  "approved_at" timestamptz,
  "transmitted_at" timestamptz,
  "channel" varchar(500) NOT NULL,
  "acknowledgement_reference" varchar(500),
  "acknowledgement_hash" varchar(500),
  "status" varchar(500) DEFAULT 'draft'
);
CREATE TABLE payment_exceptions (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "payment_transaction_id" bigint NOT NULL,
  "type" varchar(500) NOT NULL,
  "bank_reason_code" varchar(500),
  "raised_at" timestamptz,
  "notified_at" timestamptz,
  "resolution_path" text NOT NULL,
  "owner_id" bigint NOT NULL,
  "resolved_at" timestamptz,
  "status" varchar(500) DEFAULT 'open'
);
CREATE TABLE reconciliation_cases (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "invoice_id" bigint,
  "payment_transaction_id" bigint,
  "bank_reference" varchar(500) NOT NULL,
  "expected_amount" numeric(18,2) NOT NULL CHECK ("expected_amount" >= 0),
  "actual_amount" numeric(18,2) NOT NULL CHECK ("actual_amount" >= 0),
  "currency" varchar(3) NOT NULL CHECK ("currency" IN ('GHS','USD','EUR')),
  "difference_reason" text NOT NULL,
  "owner_id" bigint NOT NULL,
  "due_at" timestamptz NOT NULL,
  "resolution" text,
  "cleared_by" bigint,
  "cleared_at" timestamptz,
  "status" varchar(500) DEFAULT 'open'
);
CREATE TABLE notifications (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "user_id" bigint,
  "organization_id" bigint,
  "event_type" varchar(500) NOT NULL,
  "channel" varchar(500) NOT NULL,
  "subject" varchar(500) NOT NULL,
  "body" text NOT NULL,
  "related_resource" varchar(500),
  "related_id" varchar(500),
  "delivery_attempts" integer,
  "next_attempt_at" timestamptz,
  "delivered_at" timestamptz,
  "last_error" text,
  "status" varchar(500) DEFAULT 'queued'
);
CREATE TABLE auditor_grants (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "financier_id" bigint NOT NULL,
  "auditor_user_id" bigint NOT NULL,
  "scope" varchar(500) NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "granted_by" bigint,
  "granted_at" timestamptz,
  "status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE export_jobs (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "requester_id" bigint,
  "scope" jsonb NOT NULL,
  "purpose" text NOT NULL,
  "artifact_hash" varchar(500),
  "document_id" bigint,
  "generated_at" timestamptz,
  "delivery_record" jsonb,
  "status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE api_contract_versions (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "version" varchar(500) NOT NULL,
  "schema_reference" varchar(500) NOT NULL,
  "published_at" timestamptz,
  "deprecated_at" timestamptz,
  "sunset_at" timestamptz,
  "notice_days" integer NOT NULL
);
CREATE TABLE consumer_registrations (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "financier_id" bigint NOT NULL,
  "contract_version_id" bigint NOT NULL,
  "environment" varchar(500) NOT NULL,
  "contact_email" varchar(254) NOT NULL
);
CREATE TABLE control_total_files (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "financier_id" bigint NOT NULL,
  "business_date" date NOT NULL,
  "currency" varchar(3) NOT NULL CHECK ("currency" IN ('GHS','USD','EUR')),
  "asset_count" integer,
  "principal_outstanding" numeric(18,2) CHECK ("principal_outstanding" >= 0),
  "discount_accrued" numeric(18,2) CHECK ("discount_accrued" >= 0),
  "settlements" numeric(18,2) CHECK ("settlements" >= 0),
  "hash" varchar(500),
  "document_id" bigint
);
CREATE TABLE change_records (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "change_type" varchar(500) NOT NULL,
  "author_id" bigint NOT NULL,
  "description" text NOT NULL,
  "requirement_references" jsonb NOT NULL,
  "reviewer_id" bigint,
  "test_evidence_document_id" bigint,
  "approval_reference" varchar(500),
  "deployed_at" timestamptz,
  "emergency" boolean,
  "retrospective_approved_at" timestamptz,
  "status" varchar(500) DEFAULT 'draft'
);
CREATE TABLE dr_tests (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "test_date" date NOT NULL,
  "scope" text NOT NULL,
  "rto_target_minutes" integer NOT NULL,
  "rpo_target_minutes" integer NOT NULL,
  "rto_actual_minutes" integer,
  "rpo_actual_minutes" integer,
  "in_flight_reconciliation_result" text,
  "findings" text,
  "remediation_references" jsonb,
  "board_report_document_id" bigint,
  "status" varchar(500) DEFAULT 'planned'
);
CREATE TABLE control_metrics (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "name" varchar(500) NOT NULL,
  "definition" text NOT NULL,
  "threshold" numeric(24,8) NOT NULL,
  "evaluation_frequency" varchar(500) NOT NULL,
  "owner_role_id" bigint NOT NULL,
  "escalation_role_id" bigint,
  "acknowledgement_minutes" integer NOT NULL
);
CREATE TABLE metric_observations (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "metric_id" bigint NOT NULL,
  "value" numeric(24,8),
  "observed_at" timestamptz,
  "breach" boolean,
  "evidence_id" bigint NOT NULL
);
CREATE TABLE control_alerts (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "metric_id" bigint NOT NULL,
  "description" text NOT NULL,
  "owner_id" bigint NOT NULL,
  "raised_at" timestamptz,
  "acknowledged_by" bigint,
  "acknowledged_at" timestamptz,
  "escalated_at" timestamptz,
  "resolved_at" timestamptz,
  "resolution" text,
  "status" varchar(500) DEFAULT 'open'
);
CREATE TABLE model_registry (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "name" varchar(500) NOT NULL,
  "purpose" text NOT NULL,
  "version" varchar(500) NOT NULL,
  "training_data_description" text NOT NULL,
  "limitations" text NOT NULL,
  "accuracy_threshold" numeric(12,6) NOT NULL,
  "fallback_path" text NOT NULL,
  "approved_by" bigint,
  "deployed_at" timestamptz,
  "withdrawn_at" timestamptz,
  "status" varchar(500) DEFAULT 'draft'
);
CREATE TABLE inference_logs (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "model_id" bigint NOT NULL,
  "model_version" varchar(500),
  "inputs_reference" varchar(500) NOT NULL,
  "output" jsonb,
  "confidence" numeric(12,6),
  "routed_to_human" boolean,
  "outcome" varchar(500),
  "occurred_at" timestamptz
);
CREATE TABLE partner_obligations (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "partner_name" varchar(500) NOT NULL,
  "control_reference" varchar(500) NOT NULL,
  "accountable_party" varchar(500) NOT NULL,
  "owner_id" bigint NOT NULL,
  "obligation" text NOT NULL,
  "due_date" date NOT NULL,
  "evidence_id" bigint,
  "status" varchar(500) DEFAULT 'open'
);
CREATE TABLE assurance_reports (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "partner_name" varchar(500) NOT NULL,
  "standard" varchar(500) NOT NULL,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "document_id" bigint NOT NULL,
  "exceptions" text,
  "management_response" text,
  "reviewer_id" bigint,
  "reviewed_at" timestamptz,
  "status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE escrow_deposits (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "partner_name" varchar(500) NOT NULL,
  "deposit_reference" varchar(500) NOT NULL,
  "deposited_on" date NOT NULL,
  "build_evidence_document_id" bigint,
  "verified_by" bigint,
  "verified_at" timestamptz,
  "exit_plan_document_id" bigint NOT NULL,
  "next_review_date" date NOT NULL,
  "status" varchar(500) DEFAULT 'pending'
);
CREATE TABLE vulnerability_findings (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "finding_reference" varchar(500) NOT NULL,
  "severity" varchar(500) NOT NULL,
  "description" text NOT NULL,
  "discovered_at" timestamptz NOT NULL,
  "remediation_due" timestamptz NOT NULL,
  "owner_id" bigint NOT NULL,
  "evidence_id" bigint,
  "remediation" text,
  "independently_verified_by" bigint,
  "closed_at" timestamptz,
  "status" varchar(500) DEFAULT 'open'
);
CREATE TABLE incident_records (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "incident_reference" varchar(500) NOT NULL,
  "detected_at" timestamptz NOT NULL,
  "incident_type" varchar(500) NOT NULL,
  "severity" varchar(500) NOT NULL,
  "description" text NOT NULL,
  "owner_id" bigint NOT NULL,
  "regulator_notification_deadline" timestamptz,
  "counterparty_notification_deadline" timestamptz,
  "notified_at" timestamptz,
  "resolution" text,
  "closed_at" timestamptz,
  "status" varchar(500) DEFAULT 'open'
);
CREATE TABLE retention_policies (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "record_class" varchar(500) NOT NULL,
  "lawful_basis" varchar(500) NOT NULL,
  "jurisdiction" varchar(500) NOT NULL,
  "retention_days" integer NOT NULL,
  "erasure_method" varchar(500) NOT NULL,
  "legal_hold_rules" text,
  "owner_id" bigint NOT NULL,
  "effective_from" date NOT NULL,
  "approved_by" bigint,
  "status" varchar(500) DEFAULT 'draft'
);
CREATE TABLE data_subject_requests (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "organization_id" bigint NOT NULL,
  "request_reference" varchar(500) NOT NULL,
  "request_type" varchar(500) NOT NULL,
  "received_at" timestamptz NOT NULL,
  "response_due" timestamptz NOT NULL,
  "identity_evidence_id" bigint,
  "owner_id" bigint NOT NULL,
  "response_document_id" bigint,
  "completed_at" timestamptz,
  "status" varchar(500) DEFAULT 'open'
);
ALTER TABLE programmes ADD CONSTRAINT programmes_agreement_document_id_fk FOREIGN KEY ("agreement_document_id") REFERENCES documents(id);
ALTER TABLE programmes ADD CONSTRAINT programmes_configured_by_fk FOREIGN KEY ("configured_by") REFERENCES users(id);
ALTER TABLE programmes ADD CONSTRAINT programmes_released_by_fk FOREIGN KEY ("released_by") REFERENCES users(id);
ALTER TABLE invoices ADD CONSTRAINT invoices_supplier_approved_by_fk FOREIGN KEY ("supplier_approved_by") REFERENCES users(id);
ALTER TABLE financing_agreements ADD CONSTRAINT agreements_document_id_fk FOREIGN KEY ("document_id") REFERENCES documents(id);
ALTER TABLE organization_memberships ADD CONSTRAINT organization_memberships_organization_id_fk FOREIGN KEY ("organization_id") REFERENCES organizations(id);
ALTER TABLE organization_memberships ADD CONSTRAINT organization_memberships_user_id_fk FOREIGN KEY ("user_id") REFERENCES users(id);
ALTER TABLE organization_memberships ADD CONSTRAINT organization_memberships_role_id_fk FOREIGN KEY ("role_id") REFERENCES roles(id);
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_role_id_fk FOREIGN KEY ("role_id") REFERENCES roles(id);
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_permission_id_fk FOREIGN KEY ("permission_id") REFERENCES permissions(id);
ALTER TABLE sod_rules ADD CONSTRAINT sod_rules_role_a_fk FOREIGN KEY ("role_a") REFERENCES roles(id);
ALTER TABLE sod_rules ADD CONSTRAINT sod_rules_role_b_fk FOREIGN KEY ("role_b") REFERENCES roles(id);
ALTER TABLE sod_exceptions ADD CONSTRAINT sod_exceptions_user_id_fk FOREIGN KEY ("user_id") REFERENCES users(id);
ALTER TABLE sod_exceptions ADD CONSTRAINT sod_exceptions_rule_id_fk FOREIGN KEY ("rule_id") REFERENCES sod_rules(id);
ALTER TABLE sod_exceptions ADD CONSTRAINT sod_exceptions_approver_id_fk FOREIGN KEY ("approver_id") REFERENCES users(id);
ALTER TABLE sod_exceptions ADD CONSTRAINT sod_exceptions_second_approver_id_fk FOREIGN KEY ("second_approver_id") REFERENCES users(id);
ALTER TABLE invitations ADD CONSTRAINT invitations_supplier_id_fk FOREIGN KEY ("supplier_id") REFERENCES suppliers(id);
ALTER TABLE invitations ADD CONSTRAINT invitations_issued_by_fk FOREIGN KEY ("issued_by") REFERENCES users(id);
ALTER TABLE recertification_campaigns ADD CONSTRAINT recertification_campaigns_organization_id_fk FOREIGN KEY ("organization_id") REFERENCES organizations(id);
ALTER TABLE recertification_campaigns ADD CONSTRAINT recertification_campaigns_reviewer_id_fk FOREIGN KEY ("reviewer_id") REFERENCES users(id);
ALTER TABLE recertification_responses ADD CONSTRAINT recertification_responses_campaign_id_fk FOREIGN KEY ("campaign_id") REFERENCES recertification_campaigns(id);
ALTER TABLE recertification_responses ADD CONSTRAINT recertification_responses_user_id_fk FOREIGN KEY ("user_id") REFERENCES users(id);
ALTER TABLE recertification_responses ADD CONSTRAINT recertification_responses_reviewer_id_fk FOREIGN KEY ("reviewer_id") REFERENCES users(id);
ALTER TABLE auth_events ADD CONSTRAINT auth_events_user_id_fk FOREIGN KEY ("user_id") REFERENCES users(id);
ALTER TABLE privileged_access_requests ADD CONSTRAINT privileged_access_requests_user_id_fk FOREIGN KEY ("user_id") REFERENCES users(id);
ALTER TABLE privileged_access_requests ADD CONSTRAINT privileged_access_requests_approver_id_fk FOREIGN KEY ("approver_id") REFERENCES users(id);
ALTER TABLE privileged_access_requests ADD CONSTRAINT privileged_access_requests_second_approver_id_fk FOREIGN KEY ("second_approver_id") REFERENCES users(id);
ALTER TABLE counterparty_artefacts ADD CONSTRAINT counterparty_artefacts_organization_id_fk FOREIGN KEY ("organization_id") REFERENCES organizations(id);
ALTER TABLE counterparty_artefacts ADD CONSTRAINT counterparty_artefacts_requirement_id_fk FOREIGN KEY ("requirement_id") REFERENCES onboarding_requirements(id);
ALTER TABLE counterparty_artefacts ADD CONSTRAINT counterparty_artefacts_document_id_fk FOREIGN KEY ("document_id") REFERENCES documents(id);
ALTER TABLE counterparty_artefacts ADD CONSTRAINT counterparty_artefacts_verified_by_fk FOREIGN KEY ("verified_by") REFERENCES users(id);
ALTER TABLE ubo_records ADD CONSTRAINT ubo_records_organization_id_fk FOREIGN KEY ("organization_id") REFERENCES organizations(id);
ALTER TABLE ubo_records ADD CONSTRAINT ubo_records_verified_by_fk FOREIGN KEY ("verified_by") REFERENCES users(id);
ALTER TABLE screening_subjects ADD CONSTRAINT screening_subjects_organization_id_fk FOREIGN KEY ("organization_id") REFERENCES organizations(id);
ALTER TABLE screening_results ADD CONSTRAINT screening_results_subject_id_fk FOREIGN KEY ("subject_id") REFERENCES screening_subjects(id);
ALTER TABLE screening_results ADD CONSTRAINT screening_results_run_id_fk FOREIGN KEY ("run_id") REFERENCES screening_runs(id);
ALTER TABLE screening_results ADD CONSTRAINT screening_results_reviewer_id_fk FOREIGN KEY ("reviewer_id") REFERENCES users(id);
ALTER TABLE screening_results ADD CONSTRAINT screening_results_evidence_id_fk FOREIGN KEY ("evidence_id") REFERENCES documents(id);
ALTER TABLE refresh_schedules ADD CONSTRAINT refresh_schedules_organization_id_fk FOREIGN KEY ("organization_id") REFERENCES organizations(id);
ALTER TABLE source_verifications ADD CONSTRAINT source_verifications_organization_id_fk FOREIGN KEY ("organization_id") REFERENCES organizations(id);
ALTER TABLE source_verifications ADD CONSTRAINT source_verifications_verified_by_fk FOREIGN KEY ("verified_by") REFERENCES users(id);
ALTER TABLE related_party_matches ADD CONSTRAINT related_party_matches_buyer_id_fk FOREIGN KEY ("buyer_id") REFERENCES buyers(id);
ALTER TABLE related_party_matches ADD CONSTRAINT related_party_matches_supplier_id_fk FOREIGN KEY ("supplier_id") REFERENCES suppliers(id);
ALTER TABLE related_party_matches ADD CONSTRAINT related_party_matches_reviewer_id_fk FOREIGN KEY ("reviewer_id") REFERENCES users(id);
ALTER TABLE conditions_precedent ADD CONSTRAINT conditions_precedent_programme_id_fk FOREIGN KEY ("programme_id") REFERENCES programmes(id);
ALTER TABLE conditions_precedent ADD CONSTRAINT conditions_precedent_owner_id_fk FOREIGN KEY ("owner_id") REFERENCES users(id);
ALTER TABLE conditions_precedent ADD CONSTRAINT conditions_precedent_evidence_id_fk FOREIGN KEY ("evidence_id") REFERENCES documents(id);
ALTER TABLE conditions_precedent ADD CONSTRAINT conditions_precedent_waived_by_fk FOREIGN KEY ("waived_by") REFERENCES users(id);
ALTER TABLE documents ADD CONSTRAINT documents_organization_id_fk FOREIGN KEY ("organization_id") REFERENCES organizations(id);
ALTER TABLE documents ADD CONSTRAINT documents_buyer_id_fk FOREIGN KEY ("buyer_id") REFERENCES buyers(id);
ALTER TABLE documents ADD CONSTRAINT documents_supplier_id_fk FOREIGN KEY ("supplier_id") REFERENCES suppliers(id);
ALTER TABLE documents ADD CONSTRAINT documents_invoice_id_fk FOREIGN KEY ("invoice_id") REFERENCES invoices(id);
ALTER TABLE documents ADD CONSTRAINT documents_verified_by_fk FOREIGN KEY ("verified_by") REFERENCES users(id);
ALTER TABLE jurisdictions ADD CONSTRAINT jurisdictions_legal_opinion_document_id_fk FOREIGN KEY ("legal_opinion_document_id") REFERENCES documents(id);
ALTER TABLE jurisdictions ADD CONSTRAINT jurisdictions_reviewed_by_fk FOREIGN KEY ("reviewed_by") REFERENCES users(id);
ALTER TABLE agreement_amendments ADD CONSTRAINT agreement_amendments_programme_id_fk FOREIGN KEY ("programme_id") REFERENCES programmes(id);
ALTER TABLE agreement_amendments ADD CONSTRAINT agreement_amendments_document_id_fk FOREIGN KEY ("document_id") REFERENCES documents(id);
ALTER TABLE agreement_amendments ADD CONSTRAINT agreement_amendments_released_by_fk FOREIGN KEY ("released_by") REFERENCES users(id);
ALTER TABLE key_terms_summaries ADD CONSTRAINT key_terms_summaries_legal_approved_by_fk FOREIGN KEY ("legal_approved_by") REFERENCES users(id);
ALTER TABLE summary_acknowledgements ADD CONSTRAINT summary_acknowledgements_supplier_id_fk FOREIGN KEY ("supplier_id") REFERENCES suppliers(id);
ALTER TABLE summary_acknowledgements ADD CONSTRAINT summary_acknowledgements_summary_id_fk FOREIGN KEY ("summary_id") REFERENCES key_terms_summaries(id);
ALTER TABLE summary_acknowledgements ADD CONSTRAINT summary_acknowledgements_user_id_fk FOREIGN KEY ("user_id") REFERENCES users(id);
ALTER TABLE transfer_instruments ADD CONSTRAINT transfer_instruments_invoice_id_fk FOREIGN KEY ("invoice_id") REFERENCES invoices(id);
ALTER TABLE transfer_instruments ADD CONSTRAINT transfer_instruments_financier_id_fk FOREIGN KEY ("financier_id") REFERENCES users(id);
ALTER TABLE transfer_instruments ADD CONSTRAINT transfer_instruments_document_id_fk FOREIGN KEY ("document_id") REFERENCES documents(id);
ALTER TABLE invoice_batches ADD CONSTRAINT invoice_batches_buyer_id_fk FOREIGN KEY ("buyer_id") REFERENCES buyers(id);
ALTER TABLE ingestion_exceptions ADD CONSTRAINT ingestion_exceptions_batch_id_fk FOREIGN KEY ("batch_id") REFERENCES invoice_batches(id);
ALTER TABLE ingestion_exceptions ADD CONSTRAINT ingestion_exceptions_invoice_id_fk FOREIGN KEY ("invoice_id") REFERENCES invoices(id);
ALTER TABLE ingestion_exceptions ADD CONSTRAINT ingestion_exceptions_owner_id_fk FOREIGN KEY ("owner_id") REFERENCES users(id);
ALTER TABLE ingestion_exceptions ADD CONSTRAINT ingestion_exceptions_resolved_by_fk FOREIGN KEY ("resolved_by") REFERENCES users(id);
ALTER TABLE approval_warranties ADD CONSTRAINT approval_warranties_invoice_id_fk FOREIGN KEY ("invoice_id") REFERENCES invoices(id);
ALTER TABLE approval_warranties ADD CONSTRAINT approval_warranties_batch_id_fk FOREIGN KEY ("batch_id") REFERENCES invoice_batches(id);
ALTER TABLE approval_warranties ADD CONSTRAINT approval_warranties_approved_by_fk FOREIGN KEY ("approved_by") REFERENCES users(id);
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_invoice_id_fk FOREIGN KEY ("invoice_id") REFERENCES invoices(id);
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_requested_by_fk FOREIGN KEY ("requested_by") REFERENCES users(id);
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_assigned_to_fk FOREIGN KEY ("assigned_to") REFERENCES users(id);
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_decided_by_fk FOREIGN KEY ("decided_by") REFERENCES users(id);
ALTER TABLE dilution_events ADD CONSTRAINT dilution_events_invoice_id_fk FOREIGN KEY ("invoice_id") REFERENCES invoices(id);
ALTER TABLE dilution_events ADD CONSTRAINT dilution_events_evidence_id_fk FOREIGN KEY ("evidence_id") REFERENCES documents(id);
ALTER TABLE dilution_events ADD CONSTRAINT dilution_events_raised_by_fk FOREIGN KEY ("raised_by") REFERENCES users(id);
ALTER TABLE allocation_rules ADD CONSTRAINT allocation_rules_programme_id_fk FOREIGN KEY ("programme_id") REFERENCES programmes(id);
ALTER TABLE allocation_rules ADD CONSTRAINT allocation_rules_approved_by_fk FOREIGN KEY ("approved_by") REFERENCES users(id);
ALTER TABLE financing_tenders ADD CONSTRAINT financing_tenders_invoice_id_fk FOREIGN KEY ("invoice_id") REFERENCES invoices(id);
ALTER TABLE financing_tenders ADD CONSTRAINT financing_tenders_programme_id_fk FOREIGN KEY ("programme_id") REFERENCES programmes(id);
ALTER TABLE financing_tenders ADD CONSTRAINT financing_tenders_disclosure_policy_id_fk FOREIGN KEY ("disclosure_policy_id") REFERENCES disclosure_policies(id);
ALTER TABLE financing_tenders ADD CONSTRAINT financing_tenders_published_by_fk FOREIGN KEY ("published_by") REFERENCES users(id);
ALTER TABLE programme_financiers ADD CONSTRAINT programme_financiers_programme_id_fk FOREIGN KEY ("programme_id") REFERENCES programmes(id);
ALTER TABLE programme_financiers ADD CONSTRAINT programme_financiers_financier_id_fk FOREIGN KEY ("financier_id") REFERENCES users(id);
ALTER TABLE programme_financiers ADD CONSTRAINT programme_financiers_mandate_id_fk FOREIGN KEY ("mandate_id") REFERENCES mandate_versions(id);
ALTER TABLE programme_financiers ADD CONSTRAINT programme_financiers_accepted_by_fk FOREIGN KEY ("accepted_by") REFERENCES users(id);
ALTER TABLE mandate_versions ADD CONSTRAINT mandate_versions_financier_id_fk FOREIGN KEY ("financier_id") REFERENCES users(id);
ALTER TABLE mandate_versions ADD CONSTRAINT mandate_versions_created_by_fk FOREIGN KEY ("created_by") REFERENCES users(id);
ALTER TABLE mandate_acceptances ADD CONSTRAINT mandate_acceptances_mandate_id_fk FOREIGN KEY ("mandate_id") REFERENCES mandate_versions(id);
ALTER TABLE mandate_acceptances ADD CONSTRAINT mandate_acceptances_accepted_by_fk FOREIGN KEY ("accepted_by") REFERENCES users(id);
ALTER TABLE mandate_tests ADD CONSTRAINT mandate_tests_financier_id_fk FOREIGN KEY ("financier_id") REFERENCES users(id);
ALTER TABLE mandate_breaches ADD CONSTRAINT mandate_breaches_financier_id_fk FOREIGN KEY ("financier_id") REFERENCES users(id);
ALTER TABLE mandate_breaches ADD CONSTRAINT mandate_breaches_test_id_fk FOREIGN KEY ("test_id") REFERENCES mandate_tests(id);
ALTER TABLE limits ADD CONSTRAINT limits_approved_by_fk FOREIGN KEY ("approved_by") REFERENCES users(id);
ALTER TABLE limit_reservations ADD CONSTRAINT limit_reservations_request_id_fk FOREIGN KEY ("request_id") REFERENCES financing_requests(id);
ALTER TABLE limit_reservations ADD CONSTRAINT limit_reservations_limit_id_fk FOREIGN KEY ("limit_id") REFERENCES limits(id);
ALTER TABLE financing_requests ADD CONSTRAINT financing_requests_invoice_id_fk FOREIGN KEY ("invoice_id") REFERENCES invoices(id);
ALTER TABLE financing_requests ADD CONSTRAINT financing_requests_supplier_id_fk FOREIGN KEY ("supplier_id") REFERENCES suppliers(id);
ALTER TABLE financing_requests ADD CONSTRAINT financing_requests_submitted_by_fk FOREIGN KEY ("submitted_by") REFERENCES users(id);
ALTER TABLE bank_accounts ADD CONSTRAINT bank_accounts_organization_id_fk FOREIGN KEY ("organization_id") REFERENCES organizations(id);
ALTER TABLE bank_accounts ADD CONSTRAINT bank_accounts_supplier_id_fk FOREIGN KEY ("supplier_id") REFERENCES suppliers(id);
ALTER TABLE bank_accounts ADD CONSTRAINT bank_accounts_verified_by_fk FOREIGN KEY ("verified_by") REFERENCES users(id);
ALTER TABLE funding_decisions ADD CONSTRAINT funding_decisions_request_id_fk FOREIGN KEY ("request_id") REFERENCES financing_requests(id);
ALTER TABLE funding_decisions ADD CONSTRAINT funding_decisions_invoice_id_fk FOREIGN KEY ("invoice_id") REFERENCES invoices(id);
ALTER TABLE funding_decisions ADD CONSTRAINT funding_decisions_bank_account_id_fk FOREIGN KEY ("bank_account_id") REFERENCES bank_accounts(id);
ALTER TABLE funding_decisions ADD CONSTRAINT funding_decisions_decided_by_fk FOREIGN KEY ("decided_by") REFERENCES users(id);
ALTER TABLE availability_snapshots ADD CONSTRAINT availability_snapshots_invoice_id_fk FOREIGN KEY ("invoice_id") REFERENCES invoices(id);
ALTER TABLE disclosure_policies ADD CONSTRAINT disclosure_policies_programme_id_fk FOREIGN KEY ("programme_id") REFERENCES programmes(id);
ALTER TABLE disclosure_policies ADD CONSTRAINT disclosure_policies_consent_document_id_fk FOREIGN KEY ("consent_document_id") REFERENCES documents(id);
ALTER TABLE disclosure_policies ADD CONSTRAINT disclosure_policies_approved_by_fk FOREIGN KEY ("approved_by") REFERENCES users(id);
ALTER TABLE allocation_algorithms ADD CONSTRAINT allocation_algorithms_approved_by_fk FOREIGN KEY ("approved_by") REFERENCES users(id);
ALTER TABLE allocation_decisions ADD CONSTRAINT allocation_decisions_invoice_id_fk FOREIGN KEY ("invoice_id") REFERENCES invoices(id);
ALTER TABLE allocation_decisions ADD CONSTRAINT allocation_decisions_algorithm_id_fk FOREIGN KEY ("algorithm_id") REFERENCES allocation_algorithms(id);
ALTER TABLE allocation_decisions ADD CONSTRAINT allocation_decisions_selected_financier_id_fk FOREIGN KEY ("selected_financier_id") REFERENCES users(id);
ALTER TABLE marketplace_listings ADD CONSTRAINT marketplace_listings_invoice_id_fk FOREIGN KEY ("invoice_id") REFERENCES invoices(id);
ALTER TABLE acceptance_validations ADD CONSTRAINT acceptance_validations_listing_id_fk FOREIGN KEY ("listing_id") REFERENCES marketplace_listings(id);
ALTER TABLE funder_cash_positions ADD CONSTRAINT funder_cash_positions_financier_id_fk FOREIGN KEY ("financier_id") REFERENCES users(id);
ALTER TABLE intraday_facilities ADD CONSTRAINT intraday_facilities_financier_id_fk FOREIGN KEY ("financier_id") REFERENCES users(id);
ALTER TABLE intraday_facilities ADD CONSTRAINT intraday_facilities_board_authority_document_id_fk FOREIGN KEY ("board_authority_document_id") REFERENCES documents(id);
ALTER TABLE intraday_facilities ADD CONSTRAINT intraday_facilities_approved_by_fk FOREIGN KEY ("approved_by") REFERENCES users(id);
ALTER TABLE rate_fixings ADD CONSTRAINT rate_fixings_rate_id_fk FOREIGN KEY ("rate_id") REFERENCES reference_rates(id);
ALTER TABLE rate_corrections ADD CONSTRAINT rate_corrections_original_fixing_id_fk FOREIGN KEY ("original_fixing_id") REFERENCES rate_fixings(id);
ALTER TABLE rate_corrections ADD CONSTRAINT rate_corrections_corrected_fixing_id_fk FOREIGN KEY ("corrected_fixing_id") REFERENCES rate_fixings(id);
ALTER TABLE rate_corrections ADD CONSTRAINT rate_corrections_approved_by_fk FOREIGN KEY ("approved_by") REFERENCES users(id);
ALTER TABLE pricing_quotes ADD CONSTRAINT pricing_quotes_invoice_id_fk FOREIGN KEY ("invoice_id") REFERENCES invoices(id);
ALTER TABLE pricing_quotes ADD CONSTRAINT pricing_quotes_reference_rate_id_fk FOREIGN KEY ("reference_rate_id") REFERENCES reference_rates(id);
ALTER TABLE fx_snapshots ADD CONSTRAINT fx_snapshots_invoice_id_fk FOREIGN KEY ("invoice_id") REFERENCES invoices(id);
ALTER TABLE fx_snapshots ADD CONSTRAINT fx_snapshots_source_id_fk FOREIGN KEY ("source_id") REFERENCES fx_sources(id);
ALTER TABLE effective_configurations ADD CONSTRAINT effective_configurations_authority_document_id_fk FOREIGN KEY ("authority_document_id") REFERENCES documents(id);
ALTER TABLE effective_configurations ADD CONSTRAINT effective_configurations_created_by_fk FOREIGN KEY ("created_by") REFERENCES users(id);
ALTER TABLE effective_configurations ADD CONSTRAINT effective_configurations_released_by_fk FOREIGN KEY ("released_by") REFERENCES users(id);
ALTER TABLE standing_instructions ADD CONSTRAINT standing_instructions_supplier_id_fk FOREIGN KEY ("supplier_id") REFERENCES suppliers(id);
ALTER TABLE standing_instructions ADD CONSTRAINT standing_instructions_programme_id_fk FOREIGN KEY ("programme_id") REFERENCES programmes(id);
ALTER TABLE standing_instructions ADD CONSTRAINT standing_instructions_accepted_by_fk FOREIGN KEY ("accepted_by") REFERENCES users(id);
ALTER TABLE supplier_statements ADD CONSTRAINT supplier_statements_supplier_id_fk FOREIGN KEY ("supplier_id") REFERENCES suppliers(id);
ALTER TABLE supplier_statements ADD CONSTRAINT supplier_statements_document_id_fk FOREIGN KEY ("document_id") REFERENCES documents(id);
ALTER TABLE repayment_schedules ADD CONSTRAINT repayment_schedules_funding_id_fk FOREIGN KEY ("funding_id") REFERENCES fundings(id);
ALTER TABLE repayment_schedules ADD CONSTRAINT repayment_schedules_buyer_id_fk FOREIGN KEY ("buyer_id") REFERENCES buyers(id);
ALTER TABLE repayment_schedules ADD CONSTRAINT repayment_schedules_financier_id_fk FOREIGN KEY ("financier_id") REFERENCES users(id);
ALTER TABLE payment_transactions ADD CONSTRAINT payment_transactions_invoice_id_fk FOREIGN KEY ("invoice_id") REFERENCES invoices(id);
ALTER TABLE payment_transactions ADD CONSTRAINT payment_transactions_funding_id_fk FOREIGN KEY ("funding_id") REFERENCES fundings(id);
ALTER TABLE payment_transactions ADD CONSTRAINT payment_transactions_repayment_id_fk FOREIGN KEY ("repayment_id") REFERENCES repayments(id);
ALTER TABLE payment_transactions ADD CONSTRAINT payment_transactions_beneficiary_account_id_fk FOREIGN KEY ("beneficiary_account_id") REFERENCES bank_accounts(id);
ALTER TABLE payment_transactions ADD CONSTRAINT payment_transactions_approved_by_fk FOREIGN KEY ("approved_by") REFERENCES users(id);
ALTER TABLE payment_transactions ADD CONSTRAINT payment_transactions_original_instruction_id_fk FOREIGN KEY ("original_instruction_id") REFERENCES payment_transactions(id);
ALTER TABLE collection_accounts ADD CONSTRAINT collection_accounts_programme_id_fk FOREIGN KEY ("programme_id") REFERENCES programmes(id);
ALTER TABLE collection_accounts ADD CONSTRAINT collection_accounts_financier_id_fk FOREIGN KEY ("financier_id") REFERENCES users(id);
ALTER TABLE collection_accounts ADD CONSTRAINT collection_accounts_bank_account_id_fk FOREIGN KEY ("bank_account_id") REFERENCES bank_accounts(id);
ALTER TABLE collection_accounts ADD CONSTRAINT collection_accounts_approved_by_fk FOREIGN KEY ("approved_by") REFERENCES users(id);
ALTER TABLE misdirection_cases ADD CONSTRAINT misdirection_cases_invoice_id_fk FOREIGN KEY ("invoice_id") REFERENCES invoices(id);
ALTER TABLE misdirection_cases ADD CONSTRAINT misdirection_cases_recovery_owner_id_fk FOREIGN KEY ("recovery_owner_id") REFERENCES users(id);
ALTER TABLE misdirection_cases ADD CONSTRAINT misdirection_cases_evidence_id_fk FOREIGN KEY ("evidence_id") REFERENCES documents(id);
ALTER TABLE payment_vouchers ADD CONSTRAINT payment_vouchers_programme_id_fk FOREIGN KEY ("programme_id") REFERENCES programmes(id);
ALTER TABLE payment_vouchers ADD CONSTRAINT payment_vouchers_batch_id_fk FOREIGN KEY ("batch_id") REFERENCES invoice_batches(id);
ALTER TABLE payment_vouchers ADD CONSTRAINT payment_vouchers_document_id_fk FOREIGN KEY ("document_id") REFERENCES documents(id);
ALTER TABLE payment_vouchers ADD CONSTRAINT payment_vouchers_first_keyed_by_fk FOREIGN KEY ("first_keyed_by") REFERENCES users(id);
ALTER TABLE payment_vouchers ADD CONSTRAINT payment_vouchers_second_keyed_by_fk FOREIGN KEY ("second_keyed_by") REFERENCES users(id);
ALTER TABLE payment_files ADD CONSTRAINT payment_files_document_id_fk FOREIGN KEY ("document_id") REFERENCES documents(id);
ALTER TABLE payment_files ADD CONSTRAINT payment_files_approved_by_fk FOREIGN KEY ("approved_by") REFERENCES users(id);
ALTER TABLE payment_exceptions ADD CONSTRAINT payment_exceptions_payment_transaction_id_fk FOREIGN KEY ("payment_transaction_id") REFERENCES payment_transactions(id);
ALTER TABLE payment_exceptions ADD CONSTRAINT payment_exceptions_owner_id_fk FOREIGN KEY ("owner_id") REFERENCES users(id);
ALTER TABLE reconciliation_cases ADD CONSTRAINT reconciliation_cases_invoice_id_fk FOREIGN KEY ("invoice_id") REFERENCES invoices(id);
ALTER TABLE reconciliation_cases ADD CONSTRAINT reconciliation_cases_payment_transaction_id_fk FOREIGN KEY ("payment_transaction_id") REFERENCES payment_transactions(id);
ALTER TABLE reconciliation_cases ADD CONSTRAINT reconciliation_cases_owner_id_fk FOREIGN KEY ("owner_id") REFERENCES users(id);
ALTER TABLE reconciliation_cases ADD CONSTRAINT reconciliation_cases_cleared_by_fk FOREIGN KEY ("cleared_by") REFERENCES users(id);
ALTER TABLE notifications ADD CONSTRAINT notifications_user_id_fk FOREIGN KEY ("user_id") REFERENCES users(id);
ALTER TABLE notifications ADD CONSTRAINT notifications_organization_id_fk FOREIGN KEY ("organization_id") REFERENCES organizations(id);
ALTER TABLE auditor_grants ADD CONSTRAINT auditor_grants_financier_id_fk FOREIGN KEY ("financier_id") REFERENCES users(id);
ALTER TABLE auditor_grants ADD CONSTRAINT auditor_grants_auditor_user_id_fk FOREIGN KEY ("auditor_user_id") REFERENCES users(id);
ALTER TABLE auditor_grants ADD CONSTRAINT auditor_grants_granted_by_fk FOREIGN KEY ("granted_by") REFERENCES users(id);
ALTER TABLE export_jobs ADD CONSTRAINT export_jobs_requester_id_fk FOREIGN KEY ("requester_id") REFERENCES users(id);
ALTER TABLE export_jobs ADD CONSTRAINT export_jobs_document_id_fk FOREIGN KEY ("document_id") REFERENCES documents(id);
ALTER TABLE consumer_registrations ADD CONSTRAINT consumer_registrations_financier_id_fk FOREIGN KEY ("financier_id") REFERENCES users(id);
ALTER TABLE consumer_registrations ADD CONSTRAINT consumer_registrations_contract_version_id_fk FOREIGN KEY ("contract_version_id") REFERENCES api_contract_versions(id);
ALTER TABLE control_total_files ADD CONSTRAINT control_total_files_financier_id_fk FOREIGN KEY ("financier_id") REFERENCES users(id);
ALTER TABLE control_total_files ADD CONSTRAINT control_total_files_document_id_fk FOREIGN KEY ("document_id") REFERENCES documents(id);
ALTER TABLE change_records ADD CONSTRAINT change_records_author_id_fk FOREIGN KEY ("author_id") REFERENCES users(id);
ALTER TABLE change_records ADD CONSTRAINT change_records_reviewer_id_fk FOREIGN KEY ("reviewer_id") REFERENCES users(id);
ALTER TABLE change_records ADD CONSTRAINT change_records_test_evidence_document_id_fk FOREIGN KEY ("test_evidence_document_id") REFERENCES documents(id);
ALTER TABLE dr_tests ADD CONSTRAINT dr_tests_board_report_document_id_fk FOREIGN KEY ("board_report_document_id") REFERENCES documents(id);
ALTER TABLE control_metrics ADD CONSTRAINT control_metrics_owner_role_id_fk FOREIGN KEY ("owner_role_id") REFERENCES roles(id);
ALTER TABLE control_metrics ADD CONSTRAINT control_metrics_escalation_role_id_fk FOREIGN KEY ("escalation_role_id") REFERENCES roles(id);
ALTER TABLE metric_observations ADD CONSTRAINT metric_observations_metric_id_fk FOREIGN KEY ("metric_id") REFERENCES control_metrics(id);
ALTER TABLE metric_observations ADD CONSTRAINT metric_observations_evidence_id_fk FOREIGN KEY ("evidence_id") REFERENCES documents(id);
ALTER TABLE control_alerts ADD CONSTRAINT control_alerts_metric_id_fk FOREIGN KEY ("metric_id") REFERENCES control_metrics(id);
ALTER TABLE control_alerts ADD CONSTRAINT control_alerts_owner_id_fk FOREIGN KEY ("owner_id") REFERENCES users(id);
ALTER TABLE control_alerts ADD CONSTRAINT control_alerts_acknowledged_by_fk FOREIGN KEY ("acknowledged_by") REFERENCES users(id);
ALTER TABLE model_registry ADD CONSTRAINT model_registry_approved_by_fk FOREIGN KEY ("approved_by") REFERENCES users(id);
ALTER TABLE inference_logs ADD CONSTRAINT inference_logs_model_id_fk FOREIGN KEY ("model_id") REFERENCES model_registry(id);
ALTER TABLE partner_obligations ADD CONSTRAINT partner_obligations_owner_id_fk FOREIGN KEY ("owner_id") REFERENCES users(id);
ALTER TABLE partner_obligations ADD CONSTRAINT partner_obligations_evidence_id_fk FOREIGN KEY ("evidence_id") REFERENCES documents(id);
ALTER TABLE assurance_reports ADD CONSTRAINT assurance_reports_document_id_fk FOREIGN KEY ("document_id") REFERENCES documents(id);
ALTER TABLE assurance_reports ADD CONSTRAINT assurance_reports_reviewer_id_fk FOREIGN KEY ("reviewer_id") REFERENCES users(id);
ALTER TABLE escrow_deposits ADD CONSTRAINT escrow_deposits_build_evidence_document_id_fk FOREIGN KEY ("build_evidence_document_id") REFERENCES documents(id);
ALTER TABLE escrow_deposits ADD CONSTRAINT escrow_deposits_verified_by_fk FOREIGN KEY ("verified_by") REFERENCES users(id);
ALTER TABLE escrow_deposits ADD CONSTRAINT escrow_deposits_exit_plan_document_id_fk FOREIGN KEY ("exit_plan_document_id") REFERENCES documents(id);
ALTER TABLE vulnerability_findings ADD CONSTRAINT vulnerability_findings_owner_id_fk FOREIGN KEY ("owner_id") REFERENCES users(id);
ALTER TABLE vulnerability_findings ADD CONSTRAINT vulnerability_findings_evidence_id_fk FOREIGN KEY ("evidence_id") REFERENCES documents(id);
ALTER TABLE vulnerability_findings ADD CONSTRAINT vulnerability_findings_independently_verified_by_fk FOREIGN KEY ("independently_verified_by") REFERENCES users(id);
ALTER TABLE incident_records ADD CONSTRAINT incident_records_owner_id_fk FOREIGN KEY ("owner_id") REFERENCES users(id);
ALTER TABLE retention_policies ADD CONSTRAINT retention_policies_owner_id_fk FOREIGN KEY ("owner_id") REFERENCES users(id);
ALTER TABLE retention_policies ADD CONSTRAINT retention_policies_approved_by_fk FOREIGN KEY ("approved_by") REFERENCES users(id);
ALTER TABLE data_subject_requests ADD CONSTRAINT data_subject_requests_organization_id_fk FOREIGN KEY ("organization_id") REFERENCES organizations(id);
ALTER TABLE data_subject_requests ADD CONSTRAINT data_subject_requests_identity_evidence_id_fk FOREIGN KEY ("identity_evidence_id") REFERENCES documents(id);
ALTER TABLE data_subject_requests ADD CONSTRAINT data_subject_requests_owner_id_fk FOREIGN KEY ("owner_id") REFERENCES users(id);
ALTER TABLE data_subject_requests ADD CONSTRAINT data_subject_requests_response_document_id_fk FOREIGN KEY ("response_document_id") REFERENCES documents(id);
CREATE TABLE entity_audit_events (id bigserial PRIMARY KEY,actor_id bigint NOT NULL REFERENCES users(id),entity varchar NOT NULL,record_id bigint NOT NULL,action varchar NOT NULL,before_data jsonb,after_data jsonb,created_at timestamptz NOT NULL DEFAULT now());
CREATE TRIGGER immutable_entity_audit BEFORE UPDATE OR DELETE ON entity_audit_events FOR EACH ROW EXECUTE FUNCTION refuse_financial_mutation();
CREATE INDEX entity_audit_lookup ON entity_audit_events(entity,record_id,id);
CREATE UNIQUE INDEX unique_organization_membership ON organization_memberships(organization_id,user_id,role_id);
CREATE UNIQUE INDEX unique_role_permission ON role_permissions(role_id,permission_id);
CREATE UNIQUE INDEX unique_document_storage_key ON documents(storage_key);
CREATE UNIQUE INDEX unique_invoice_reference_per_programme_supplier ON invoices(programme_id,supplier_id,invoice_number) WHERE invoice_number IS NOT NULL AND btrim(invoice_number)<>'';

UPDATE invoices SET financial_review_required=true WHERE EXISTS(SELECT 1 FROM bids WHERE bids.invoice_id=invoices.id AND bids.status=1 AND bids.pricing_snapshot IS NULL) AND NOT EXISTS(SELECT 1 FROM fundings WHERE fundings.invoice_id=invoices.id AND fundings.status='completed');
