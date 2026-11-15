-- Alignment of increments 1–2 with SCF Platform SRS Appendix B after a requirement-by-requirement review.

-- FR-JNY-A-003: the checklist is resolved by jurisdiction AND entity type (and tier for suppliers).
ALTER TABLE organisation_lifecycle ADD COLUMN IF NOT EXISTS entity_type varchar NOT NULL DEFAULT 'limited_company';
ALTER TABLE organisation_lifecycle DROP CONSTRAINT IF EXISTS organisation_lifecycle_entity_type_check;
ALTER TABLE organisation_lifecycle ADD CONSTRAINT organisation_lifecycle_entity_type_check CHECK (entity_type IN ('limited_company','public_company','partnership','sole_proprietor','state_owned','bank','non_bank_financial','fund','other'));
-- Who owns the relationship: internal notifications (A2.7, S2.6, bank changes) route to this person.
ALTER TABLE organisation_lifecycle ADD COLUMN IF NOT EXISTS relationship_manager_id bigint REFERENCES users(id);
UPDATE organisation_lifecycle l SET relationship_manager_id=e.actor_id FROM organisation_status_events e
  WHERE e.org_ref=l.org_ref AND e.previous_status IS NULL AND l.relationship_manager_id IS NULL AND l.counterparty IN ('ANCHOR','FUNDER');

ALTER TABLE compliance_checklist_items ADD COLUMN IF NOT EXISTS entity_type varchar NOT NULL DEFAULT '*';
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='compliance_checklist_items'::regclass AND contype='u' LOOP
    EXECUTE format('ALTER TABLE compliance_checklist_items DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS compliance_checklist_items_scope ON compliance_checklist_items(counterparty, country, entity_type, tier, item_key);
-- Entity-specific requirements (examples the SRS calls for): partnerships file the partnership deed instead of a
-- constitution; sole proprietors file a business-name registration; regulated funders file their licence.
INSERT INTO compliance_checklist_items(counterparty,country,entity_type,tier,item_key,label,guidance,expires,sort) VALUES
 ('ANCHOR','*','partnership','standard','partnership_deed','Partnership deed','The executed deed and any amendments',false,2),
 ('SUPPLIER','*','sole_proprietor','simplified','business_name_registration','Business name registration certificate','Issued by the Registrar-General',false,1),
 ('SUPPLIER','*','sole_proprietor','full','business_name_registration','Business name registration certificate','Issued by the Registrar-General',false,1)
ON CONFLICT DO NOTHING;
-- Items that do not apply to an entity type are excluded explicitly rather than by code.
CREATE TABLE IF NOT EXISTS compliance_checklist_exclusions (
  counterparty varchar NOT NULL, entity_type varchar NOT NULL, item_key varchar NOT NULL,
  PRIMARY KEY (counterparty, entity_type, item_key)
);
INSERT INTO compliance_checklist_exclusions VALUES
 ('ANCHOR','partnership','constitution'),
 ('SUPPLIER','sole_proprietor','incorporation')
ON CONFLICT DO NOTHING;

-- FR-JNY-F-003: the funder's due-diligence pack is attached before its record can exist.
-- A2.2 / NFR retention: every filed compliance document carries a retention clock.
INSERT INTO onboarding_settings(key,value) VALUES
  ('document_retention_years','7'),
  ('rescreening_months','{"low":12,"medium":12,"high":6}'),
  ('onboarding_reminder_days','[3,7,14]'),
  ('terms_versions','{"terms_of_use":"2026-11","privacy_notice":"2026-11"}'),
  ('templates','{
    "supplier_invitation": {
      "email": {"subject":"{anchor} invites you to get paid early with INVOX","body":"{anchor} uses INVOX so its suppliers can choose to be paid early on approved invoices. Set up your account here: {link}\\n\\nThis link is personal to you and expires on {expiry}."},
      "sms": {"body":"{anchor} invites you to get paid early on approved invoices with INVOX. Set up your account: {link} (expires {expiry})"}
    },
    "onboarding_reminder": {
      "email": {"subject":"Finish setting up INVOX for {anchor}","body":"You are {remaining} away from being able to get paid early by {anchor}. Continue where you left off: {link}"},
      "sms": {"body":"Finish your INVOX set-up to get paid early by {anchor}: {link}"}
    }
  }')
ON CONFLICT DO NOTHING;

-- S1.2 / FR-JNY-S-030: remember the channel the supplier actually responded on; reminders follow it.
ALTER TABLE programme_enrolments ADD COLUMN IF NOT EXISTS responded_channel varchar;
ALTER TABLE programme_enrolments ADD COLUMN IF NOT EXISTS reminders_sent integer NOT NULL DEFAULT 0;
ALTER TABLE programme_enrolments ADD COLUMN IF NOT EXISTS last_reminded_at timestamptz;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS preferred_channel varchar;

-- FR-ONB-010: explicit, timestamped consent to the platform terms and privacy notice.
CREATE TABLE IF NOT EXISTS platform_consents (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  terms_version varchar NOT NULL,
  privacy_version varchar NOT NULL,
  context varchar NOT NULL,
  ip varchar,
  accepted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_consents_user_idx ON platform_consents(user_id);
DROP TRIGGER IF EXISTS platform_consents_append_only ON platform_consents;
CREATE TRIGGER platform_consents_append_only BEFORE UPDATE OR DELETE ON platform_consents FOR EACH ROW EXECUTE FUNCTION refuse_financial_mutation();

-- S1.3 / A4.10 / F3.6 / NFR-SEC-002: people provisioned or registered under the SRS process must use a second factor.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_required boolean NOT NULL DEFAULT false;
UPDATE users SET mfa_required=true WHERE org_role IS NOT NULL AND provisioning_status<>'ACTIVE';
UPDATE users u SET mfa_required=true FROM organisation_lifecycle l WHERE u.org_ref=l.org_ref AND NOT l.legacy;

-- FR-JNY-S-029: after verification a supplier's bank account changes only on a signed written request.
ALTER TABLE settlement_accounts ADD COLUMN IF NOT EXISTS request_document_id bigint REFERENCES documents(id);

-- NFR-AUD-001: who did what, when, from where and why.
ALTER TABLE portal_events ADD COLUMN IF NOT EXISTS ip varchar;
ALTER TABLE organisation_status_events ADD COLUMN IF NOT EXISTS ip varchar;

-- §13.4 Notifications: in-app and email as a minimum, queued for retry, logged against the recipient. A contact who is
-- not a platform user (e.g. a finance contact) is addressed directly.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS recipient varchar;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS org_ref varchar;
CREATE INDEX IF NOT EXISTS notifications_queue_idx ON notifications(next_attempt_at) WHERE channel='email' AND status='queued';
CREATE INDEX IF NOT EXISTS notifications_org_idx ON notifications(org_ref) WHERE org_ref IS NOT NULL;
-- Scheduled notices (reminders, re-verification due) are raised by the platform itself, not by a person.
ALTER TABLE notifications ALTER COLUMN created_by DROP NOT NULL;
