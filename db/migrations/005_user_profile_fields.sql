-- Additive user profile metadata; authority fields remain workflow-controlled.

ALTER TABLE users ADD COLUMN IF NOT EXISTS "name" varchar(200);
ALTER TABLE users ADD COLUMN IF NOT EXISTS "contact_phone" varchar(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS "country" varchar(2);
ALTER TABLE users ADD COLUMN IF NOT EXISTS "preferred_language" varchar(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS "timezone" varchar(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS "recert_cycle" integer;
ALTER TABLE users ADD COLUMN IF NOT EXISTS obo_confirmed_at timestamptz;
