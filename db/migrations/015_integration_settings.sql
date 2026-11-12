-- Live integration settings (email, SMS, payment providers). Non-secret settings are plain JSON; credentials are
-- stored only as an AES-256-GCM sealed blob and are never returned to the browser.
CREATE TABLE IF NOT EXISTS integration_settings (
  provider varchar PRIMARY KEY CHECK (provider IN ('smtp','mnotify','paystack','flutterwave','ghipss','payment_routing')),
  enabled boolean NOT NULL DEFAULT false,
  mode varchar NOT NULL DEFAULT 'test' CHECK (mode IN ('test','live')),
  config jsonb NOT NULL DEFAULT '{}',
  secrets_sealed text,
  secret_hints jsonb NOT NULL DEFAULT '{}',
  updated_by bigint REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_tested_at timestamptz,
  last_test_ok boolean,
  last_test_message text
);
