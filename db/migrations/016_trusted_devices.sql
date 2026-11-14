-- Browsers a user chose to trust after completing two-step verification. Only a hash of the device token is
-- stored. Trust is bound to the account's credential epoch (users.jti): a password change, reset or session
-- revocation rotates it and every trusted device stops working. Re-enrolling the authenticator also ends it.
CREATE TABLE IF NOT EXISTS trusted_devices (
  id bigserial PRIMARY KEY,
  token_hash varchar(64) NOT NULL UNIQUE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_jti varchar NOT NULL,
  label varchar(200),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS trusted_devices_user_idx ON trusted_devices(user_id);
