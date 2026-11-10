-- Additional data-model fields from SCF-RCR-001, including proposed controls.

-- Tables capture draft records; they do not enable their operational workflows.

CREATE TABLE tenant_relationships (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "organization_id" bigint NOT NULL,
  "related_organization_id" bigint NOT NULL,
  "relationship_type" varchar(500) NOT NULL,
  "sharing_scope" jsonb NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "approved_by" bigint,
  "status" varchar(500) DEFAULT 'draft'
);

CREATE TABLE step_up_challenges (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "user_id" bigint NOT NULL,
  "action_code" varchar(500) NOT NULL,
  "assurance_level" varchar(500) NOT NULL,
  "challenge_hash" varchar(64),
  "issued_at" timestamptz,
  "expires_at" timestamptz,
  "consumed_at" timestamptz,
  "result" varchar(500),
  "status" varchar(500) DEFAULT 'draft'
);

CREATE TABLE privileged_accounts (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "user_id" bigint NOT NULL,
  "natural_person_reference" varchar(500) NOT NULL,
  "employer" varchar(500) NOT NULL,
  "privileged_role" varchar(500) NOT NULL,
  "last_reviewed_at" timestamptz,
  "reviewed_by" bigint,
  "status" varchar(500) DEFAULT 'draft'
);

CREATE TABLE cross_tenant_access_logs (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "principal_id" bigint NOT NULL,
  "organization_id" bigint NOT NULL,
  "entity" varchar(500) NOT NULL,
  "action_code" varchar(500) NOT NULL,
  "justification_reference" varchar(500) NOT NULL,
  "occurred_at" timestamptz
);

CREATE TABLE party_attributes (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "organization_id" bigint NOT NULL,
  "attribute_type" varchar(500) NOT NULL,
  "normalized_value" varchar(500) NOT NULL,
  "source" varchar(500) NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date
);

CREATE TABLE agreement_terms (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "agreement_id" bigint NOT NULL,
  "parameter_code" varchar(500) NOT NULL,
  "value" jsonb NOT NULL,
  "effective_from" date NOT NULL,
  "clause_reference" varchar(500) NOT NULL,
  "status" varchar(500) DEFAULT 'draft'
);

CREATE TABLE reconciliation_runs (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "buyer_id" bigint NOT NULL,
  "as_at" date NOT NULL,
  "source_count" integer NOT NULL CHECK ("source_count">=0),
  "source_total" numeric(18,2) NOT NULL CHECK ("source_total">=0),
  "platform_count" integer CHECK ("platform_count">=0),
  "platform_total" numeric(18,2) CHECK ("platform_total">=0),
  "variance" numeric(24,8),
  "status" varchar(500) DEFAULT 'draft'
);

CREATE TABLE reconciliation_exceptions (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "run_id" bigint NOT NULL,
  "invoice_id" bigint,
  "invoice_reference" varchar(500) NOT NULL,
  "exception_type" varchar(500) NOT NULL,
  "owner_id" bigint,
  "first_seen" timestamptz,
  "age_days" integer CHECK ("age_days">=0),
  "cleared_at" timestamptz,
  "status" varchar(500) DEFAULT 'draft'
);

CREATE TABLE counterparty_keys (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "organization_id" bigint NOT NULL,
  "public_key" text NOT NULL,
  "algorithm" varchar(500) NOT NULL,
  "valid_from" date NOT NULL,
  "valid_to" date,
  "fingerprint" varchar(64) NOT NULL,
  "registered_by" bigint,
  "status" varchar(500) DEFAULT 'draft'
);

CREATE TABLE payload_receipts (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "organization_id" bigint NOT NULL,
  "key_id" bigint NOT NULL,
  "payload_reference" varchar(500) NOT NULL,
  "signature" text NOT NULL,
  "verified_at" timestamptz,
  "result" varchar(500)
);

CREATE TABLE voucher_returns (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "voucher_id" bigint NOT NULL,
  "document_id" bigint NOT NULL,
  "signatories" jsonb,
  "received_at" timestamptz,
  "extracted_hash" varchar(64),
  "verification_result" varchar(500),
  "status" varchar(500) DEFAULT 'draft'
);

CREATE TABLE voucher_captures (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "voucher_id" bigint NOT NULL,
  "method" varchar(500) NOT NULL CHECK ("method" IN ('scanned','integrated','manual')),
  "first_value" jsonb,
  "second_value" jsonb,
  "first_operator_id" bigint,
  "second_operator_id" bigint,
  "agreed" boolean,
  "captured_at" timestamptz,
  "status" varchar(500) DEFAULT 'draft'
);

CREATE TABLE pre_run_validations (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "payment_file_id" bigint NOT NULL,
  "check_code" varchar(500) NOT NULL,
  "input_snapshot" jsonb,
  "result" varchar(500),
  "validated_by" bigint,
  "validated_at" timestamptz,
  "status" varchar(500) DEFAULT 'draft'
);

CREATE TABLE trade_evidence (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "invoice_id" bigint NOT NULL,
  "document_id" bigint NOT NULL,
  "evidence_type" varchar(500) NOT NULL,
  "obtained_on" date,
  "verified_by" bigint,
  "verified_at" timestamptz,
  "outcome" varchar(500),
  "status" varchar(500) DEFAULT 'draft'
);

CREATE TABLE risk_signals (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "subject_type" varchar(500) NOT NULL,
  "subject_reference" varchar(500) NOT NULL,
  "signal_code" varchar(500) NOT NULL,
  "evidence" jsonb,
  "score" numeric(24,8),
  "detected_at" timestamptz,
  "disposition" varchar(500),
  "status" varchar(500) DEFAULT 'draft'
);

CREATE TABLE pair_profiles (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "buyer_id" bigint NOT NULL,
  "supplier_id" bigint NOT NULL,
  "period" varchar(500) NOT NULL,
  "baseline_count" integer CHECK ("baseline_count">=0),
  "baseline_value" numeric(18,2) CHECK ("baseline_value">=0),
  "value_distribution" jsonb,
  "tenor_distribution" jsonb,
  "calculated_at" timestamptz,
  "status" varchar(500) DEFAULT 'draft'
);

CREATE TABLE warranty_versions (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "name" varchar(500) NOT NULL,
  "version" varchar(500) NOT NULL,
  "legal_text" text NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "approved_by_legal_id" bigint,
  "approved_at" timestamptz,
  "status" varchar(500) DEFAULT 'draft'
);

CREATE TABLE programme_dilution_positions (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "programme_id" bigint NOT NULL,
  "period" varchar(500) NOT NULL,
  "cumulative_dilution" numeric(18,2) CHECK ("cumulative_dilution">=0),
  "financed_principal" numeric(18,2) CHECK ("financed_principal">=0),
  "dilution_percent" numeric(12,6) CHECK ("dilution_percent">=0),
  "as_at" timestamptz
);

CREATE TABLE availability_withdrawals (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "invoice_id" bigint NOT NULL,
  "previous_tier" varchar(500) NOT NULL,
  "reason_code" varchar(500) NOT NULL,
  "withdrawn_at" timestamptz,
  "withdrawn_by" bigint
);

CREATE TABLE pre_disbursement_checks (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "request_id" bigint NOT NULL,
  "invoice_id" bigint NOT NULL,
  "check_code" varchar(500) NOT NULL,
  "evidence" jsonb,
  "result" varchar(500),
  "checked_at" timestamptz,
  "status" varchar(500) DEFAULT 'draft'
);

CREATE TABLE bank_account_change_logs (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "bank_account_id" bigint NOT NULL,
  "actor_id" bigint,
  "previous_hash" varchar(64),
  "new_hash" varchar(64),
  "changed_at" timestamptz,
  "verification_result" varchar(500),
  "justification_reference" varchar(500) NOT NULL
);

CREATE TABLE portfolio_positions (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "financier_id" bigint NOT NULL,
  "dimension" varchar(500) NOT NULL,
  "dimension_value" varchar(500) NOT NULL,
  "currency" varchar(500) NOT NULL CHECK ("currency" IN ('GHS','USD','EUR')),
  "principal" numeric(18,2) CHECK ("principal">=0),
  "portfolio_percentage" numeric(12,6) CHECK ("portfolio_percentage">=0),
  "as_at" timestamptz
);

CREATE TABLE fairness_reports (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "financier_id" bigint NOT NULL,
  "programme_id" bigint NOT NULL,
  "period" varchar(500) NOT NULL,
  "eligible_count" integer CHECK ("eligible_count">=0),
  "allocated_count" integer CHECK ("allocated_count">=0),
  "allocated_amount" numeric(18,2) CHECK ("allocated_amount">=0),
  "generated_at" timestamptz,
  "analysis" jsonb
);

CREATE TABLE facility_utilisations (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "facility_id" bigint NOT NULL,
  "invoice_id" bigint NOT NULL,
  "amount" numeric(18,2) NOT NULL CHECK ("amount">=0),
  "used_at" timestamptz,
  "repaid_at" timestamptz,
  "status" varchar(500) DEFAULT 'draft'
);

CREATE TABLE requote_events (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "previous_quote_id" bigint NOT NULL,
  "replacement_quote_id" bigint NOT NULL,
  "reason" varchar(500) NOT NULL,
  "occurred_at" timestamptz,
  "supplier_accepted_at" timestamptz
);

CREATE TABLE fx_exceptions (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "snapshot_id" bigint NOT NULL,
  "tolerance_bps" numeric(24,8) NOT NULL,
  "evidence" jsonb,
  "observed_variance_bps" numeric(24,8),
  "raised_at" timestamptz,
  "resolved_at" timestamptz,
  "status" varchar(500) DEFAULT 'draft'
);

CREATE TABLE jurisdiction_templates (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "jurisdiction" varchar(500) NOT NULL,
  "governing_law" varchar(500) NOT NULL,
  "instrument_type" varchar(500) NOT NULL,
  "version" varchar(500) NOT NULL,
  "document_id" bigint NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "approved_by_legal_id" bigint,
  "approved_at" timestamptz,
  "status" varchar(500) DEFAULT 'draft'
);

CREATE TABLE payment_quarantines (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "payment_file_id" bigint NOT NULL,
  "reason" varchar(500) NOT NULL,
  "expected_hash" varchar(500) NOT NULL,
  "observed_hash" varchar(500) NOT NULL,
  "raised_at" timestamptz,
  "released_by" bigint,
  "released_at" timestamptz,
  "status" varchar(500) DEFAULT 'draft'
);

CREATE TABLE statement_projections (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "party_role" varchar(500) NOT NULL,
  "permitted_fields" jsonb NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "approved_by" bigint,
  "status" varchar(500) DEFAULT 'draft'
);

CREATE TABLE regression_results (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "change_id" bigint NOT NULL,
  "suite_name" varchar(500) NOT NULL,
  "version" varchar(500) NOT NULL,
  "evidence_reference" varchar(500) NOT NULL,
  "executed_at" timestamptz,
  "passed_count" integer CHECK ("passed_count">=0),
  "failed_count" integer CHECK ("failed_count">=0),
  "result" varchar(500),
  "status" varchar(500) DEFAULT 'draft'
);

CREATE TABLE sbom_artefacts (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "change_id" bigint NOT NULL,
  "document_id" bigint NOT NULL,
  "release_version" varchar(500) NOT NULL,
  "content_hash" varchar(64) NOT NULL,
  "generated_at" timestamptz,
  "verified_at" timestamptz,
  "status" varchar(500) DEFAULT 'draft'
);

CREATE TABLE drift_observations (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "model_id" bigint NOT NULL,
  "model_version" varchar(500) NOT NULL,
  "metric_name" varchar(500) NOT NULL,
  "reference_sample_reference" varchar(500) NOT NULL,
  "threshold" numeric(24,8) NOT NULL,
  "observed_value" numeric(24,8),
  "observed_at" timestamptz,
  "breach" boolean,
  "status" varchar(500) DEFAULT 'draft'
);

CREATE TABLE service_metric_observations (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "obligation_id" bigint NOT NULL,
  "metric_name" varchar(500) NOT NULL,
  "period" varchar(500) NOT NULL,
  "target" numeric(24,8) NOT NULL,
  "observed_value" numeric(24,8) NOT NULL,
  "evidence_reference" varchar(500) NOT NULL,
  "recorded_at" timestamptz,
  "breach" boolean,
  "status" varchar(500) DEFAULT 'draft'
);

CREATE TABLE tax_rules (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "name" varchar(500) NOT NULL,
  "jurisdiction" varchar(500) NOT NULL,
  "counterparty_country" varchar(2) NOT NULL,
  "product" varchar(500) NOT NULL,
  "tax_type" varchar(500) NOT NULL,
  "rate" numeric(12,6) NOT NULL CHECK ("rate">=0),
  "legal_reference" varchar(500) NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "released_by" bigint,
  "released_at" timestamptz,
  "status" varchar(500) DEFAULT 'draft'
);

CREATE TABLE tax_invoices (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "invoice_id" bigint NOT NULL,
  "supplier_id" bigint NOT NULL,
  "tax_rule_id" bigint NOT NULL,
  "tax_invoice_reference" varchar(500) NOT NULL,
  "currency" varchar(500) NOT NULL CHECK ("currency" IN ('GHS','USD','EUR')),
  "taxable_amount" numeric(18,2) NOT NULL CHECK ("taxable_amount">=0),
  "tax_amount" numeric(18,2) CHECK ("tax_amount">=0),
  "document_id" bigint,
  "issued_at" timestamptz,
  "status" varchar(500) DEFAULT 'draft'
);

CREATE TABLE withholding_remittances (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "buyer_id" bigint NOT NULL,
  "supplier_id" bigint NOT NULL,
  "invoice_id" bigint,
  "tax_period" varchar(500) NOT NULL,
  "deducted_amount" numeric(18,2) NOT NULL CHECK ("deducted_amount">=0),
  "currency" varchar(500) NOT NULL CHECK ("currency" IN ('GHS','USD','EUR')),
  "statutory_due_date" date NOT NULL,
  "revenue_authority" varchar(500) NOT NULL,
  "receipt_reference" varchar(500),
  "certificate_document_id" bigint,
  "remitted_at" timestamptz,
  "verified_by" bigint,
  "status" varchar(500) DEFAULT 'draft'
);

CREATE TABLE complaints (
  id bigserial PRIMARY KEY,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  "organization_id" bigint NOT NULL,
  "category" varchar(500) NOT NULL,
  "description" text NOT NULL,
  "contact_email" varchar(500) NOT NULL,
  "acknowledgement_due_date" date NOT NULL,
  "resolution_due_date" date NOT NULL,
  "root_cause" varchar(500),
  "resolution_summary" text,
  "acknowledged_at" timestamptz,
  "resolved_at" timestamptz,
  "status" varchar(500) DEFAULT 'draft'
);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS "invoice_number_normalized" varchar(500);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS "payee_routing_state" varchar(500);

ALTER TABLE source_verifications ADD COLUMN IF NOT EXISTS "request_reference" varchar(500);

ALTER TABLE source_verifications ADD COLUMN IF NOT EXISTS "response_payload_reference" varchar(500);

ALTER TABLE source_verifications ADD COLUMN IF NOT EXISTS "expires_on" date;

ALTER TABLE approval_warranties ADD COLUMN IF NOT EXISTS "warranty_version_id" bigint;

ALTER TABLE approval_warranties ADD COLUMN IF NOT EXISTS "acting_role_id" bigint;

ALTER TABLE effective_configurations ADD COLUMN IF NOT EXISTS "agreement_term_id" bigint;

ALTER TABLE tenant_relationships ADD FOREIGN KEY ("organization_id") REFERENCES organizations(id);

ALTER TABLE tenant_relationships ADD FOREIGN KEY ("related_organization_id") REFERENCES organizations(id);

ALTER TABLE step_up_challenges ADD FOREIGN KEY ("user_id") REFERENCES users(id);

ALTER TABLE privileged_accounts ADD FOREIGN KEY ("user_id") REFERENCES users(id);

ALTER TABLE cross_tenant_access_logs ADD FOREIGN KEY ("principal_id") REFERENCES users(id);

ALTER TABLE cross_tenant_access_logs ADD FOREIGN KEY ("organization_id") REFERENCES organizations(id);

ALTER TABLE party_attributes ADD FOREIGN KEY ("organization_id") REFERENCES organizations(id);

ALTER TABLE agreement_terms ADD FOREIGN KEY ("agreement_id") REFERENCES financing_agreements(id);

ALTER TABLE reconciliation_runs ADD FOREIGN KEY ("buyer_id") REFERENCES buyers(id);

ALTER TABLE reconciliation_exceptions ADD FOREIGN KEY ("run_id") REFERENCES reconciliation_runs(id);

ALTER TABLE reconciliation_exceptions ADD FOREIGN KEY ("invoice_id") REFERENCES invoices(id);

ALTER TABLE reconciliation_exceptions ADD FOREIGN KEY ("owner_id") REFERENCES users(id);

ALTER TABLE counterparty_keys ADD FOREIGN KEY ("organization_id") REFERENCES organizations(id);

ALTER TABLE payload_receipts ADD FOREIGN KEY ("organization_id") REFERENCES organizations(id);

ALTER TABLE payload_receipts ADD FOREIGN KEY ("key_id") REFERENCES counterparty_keys(id);

ALTER TABLE voucher_returns ADD FOREIGN KEY ("voucher_id") REFERENCES payment_vouchers(id);

ALTER TABLE voucher_returns ADD FOREIGN KEY ("document_id") REFERENCES documents(id);

ALTER TABLE voucher_captures ADD FOREIGN KEY ("voucher_id") REFERENCES payment_vouchers(id);

ALTER TABLE pre_run_validations ADD FOREIGN KEY ("payment_file_id") REFERENCES payment_files(id);

ALTER TABLE trade_evidence ADD FOREIGN KEY ("invoice_id") REFERENCES invoices(id);

ALTER TABLE trade_evidence ADD FOREIGN KEY ("document_id") REFERENCES documents(id);

ALTER TABLE pair_profiles ADD FOREIGN KEY ("buyer_id") REFERENCES buyers(id);

ALTER TABLE pair_profiles ADD FOREIGN KEY ("supplier_id") REFERENCES suppliers(id);

ALTER TABLE programme_dilution_positions ADD FOREIGN KEY ("programme_id") REFERENCES programmes(id);

ALTER TABLE availability_withdrawals ADD FOREIGN KEY ("invoice_id") REFERENCES invoices(id);

ALTER TABLE pre_disbursement_checks ADD FOREIGN KEY ("request_id") REFERENCES financing_requests(id);

ALTER TABLE pre_disbursement_checks ADD FOREIGN KEY ("invoice_id") REFERENCES invoices(id);

ALTER TABLE bank_account_change_logs ADD FOREIGN KEY ("bank_account_id") REFERENCES bank_accounts(id);

ALTER TABLE portfolio_positions ADD FOREIGN KEY ("financier_id") REFERENCES users(id);

ALTER TABLE fairness_reports ADD FOREIGN KEY ("financier_id") REFERENCES users(id);

ALTER TABLE fairness_reports ADD FOREIGN KEY ("programme_id") REFERENCES programmes(id);

ALTER TABLE facility_utilisations ADD FOREIGN KEY ("facility_id") REFERENCES intraday_facilities(id);

ALTER TABLE facility_utilisations ADD FOREIGN KEY ("invoice_id") REFERENCES invoices(id);

ALTER TABLE requote_events ADD FOREIGN KEY ("previous_quote_id") REFERENCES pricing_quotes(id);

ALTER TABLE requote_events ADD FOREIGN KEY ("replacement_quote_id") REFERENCES pricing_quotes(id);

ALTER TABLE fx_exceptions ADD FOREIGN KEY ("snapshot_id") REFERENCES fx_snapshots(id);

ALTER TABLE jurisdiction_templates ADD FOREIGN KEY ("document_id") REFERENCES documents(id);

ALTER TABLE payment_quarantines ADD FOREIGN KEY ("payment_file_id") REFERENCES payment_files(id);

ALTER TABLE regression_results ADD FOREIGN KEY ("change_id") REFERENCES change_records(id);

ALTER TABLE sbom_artefacts ADD FOREIGN KEY ("change_id") REFERENCES change_records(id);

ALTER TABLE sbom_artefacts ADD FOREIGN KEY ("document_id") REFERENCES documents(id);

ALTER TABLE drift_observations ADD FOREIGN KEY ("model_id") REFERENCES model_registry(id);

ALTER TABLE service_metric_observations ADD FOREIGN KEY ("obligation_id") REFERENCES partner_obligations(id);

ALTER TABLE tax_invoices ADD FOREIGN KEY ("invoice_id") REFERENCES invoices(id);

ALTER TABLE tax_invoices ADD FOREIGN KEY ("supplier_id") REFERENCES suppliers(id);

ALTER TABLE tax_invoices ADD FOREIGN KEY ("tax_rule_id") REFERENCES tax_rules(id);

ALTER TABLE tax_invoices ADD FOREIGN KEY ("document_id") REFERENCES documents(id);

ALTER TABLE withholding_remittances ADD FOREIGN KEY ("buyer_id") REFERENCES buyers(id);

ALTER TABLE withholding_remittances ADD FOREIGN KEY ("supplier_id") REFERENCES suppliers(id);

ALTER TABLE withholding_remittances ADD FOREIGN KEY ("invoice_id") REFERENCES invoices(id);

ALTER TABLE withholding_remittances ADD FOREIGN KEY ("certificate_document_id") REFERENCES documents(id);

ALTER TABLE complaints ADD FOREIGN KEY ("organization_id") REFERENCES organizations(id);

ALTER TABLE approval_warranties ADD FOREIGN KEY ("warranty_version_id") REFERENCES warranty_versions(id);

ALTER TABLE effective_configurations ADD FOREIGN KEY ("agreement_term_id") REFERENCES agreement_terms(id);

ALTER TABLE financing_agreements ADD CONSTRAINT configured_recourse CHECK(recourse_type IS NULL OR recourse_type IN ('recourse','non_recourse','limited_recourse')) NOT VALID;
