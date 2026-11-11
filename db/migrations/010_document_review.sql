-- Operations review of uploaded evidence. Verification reuses the existing
-- verified_by / verified_at columns; a rejection keeps its reason for audit.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS review_status varchar(20) NOT NULL DEFAULT 'pending'
  CHECK (review_status IN ('pending','verified','rejected'));
ALTER TABLE documents ADD COLUMN IF NOT EXISTS review_reason text;
UPDATE documents SET review_status='verified' WHERE verified_at IS NOT NULL AND review_status='pending';
