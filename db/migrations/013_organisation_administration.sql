-- Preserve the actual uploader; delegated ownership is a separate association.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS org_ref varchar;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS on_behalf_of_user_id bigint REFERENCES users(id);
CREATE INDEX IF NOT EXISTS documents_org_ref ON documents(org_ref) WHERE archived_at IS NULL;
CREATE TABLE organisation_kyc_drafts (
 org_ref varchar PRIMARY KEY, payload jsonb NOT NULL DEFAULT '{}',
 updated_by bigint NOT NULL REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE organisation_admin_events (
 id bigserial PRIMARY KEY, org_ref varchar NOT NULL, actor_id bigint NOT NULL REFERENCES users(id),
 operation varchar NOT NULL, reason text NOT NULL, details jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organisation_admin_events_org ON organisation_admin_events(org_ref,id DESC);
CREATE TRIGGER immutable_organisation_admin_events BEFORE UPDATE OR DELETE ON organisation_admin_events
 FOR EACH ROW EXECUTE FUNCTION refuse_financial_mutation();
