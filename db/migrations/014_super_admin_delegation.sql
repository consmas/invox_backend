-- Super administrators may act on behalf of an organisation. The flag is granted only by the seed script
-- (never through the API) and only an operations account can hold it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS super_admin boolean NOT NULL DEFAULT false;
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_super_admin_operations CHECK (NOT super_admin OR role = 2);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Events keep the organisation account the action was taken for (actor_id) and the administrator who took it.
ALTER TABLE portal_events ADD COLUMN IF NOT EXISTS acting_admin_id bigint REFERENCES users(id);
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS acting_admin_id bigint REFERENCES users(id);
CREATE INDEX IF NOT EXISTS portal_events_acting_admin ON portal_events(acting_admin_id) WHERE acting_admin_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_events_acting_admin ON audit_events(acting_admin_id) WHERE acting_admin_id IS NOT NULL;
