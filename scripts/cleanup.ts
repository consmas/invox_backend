import { loadEnvConfig } from '@next/env';
import { closePool, rows } from '../src/server/db';

// Load .env.production only when NODE_ENV=production; local runs use .env.local / .env.development.
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');
async function cleanup() {
  await rows('DELETE FROM app_sessions WHERE expires_at < now()');
  await rows("DELETE FROM auth_rate_limits WHERE window_start < now()-interval '1 day'");
  await rows('DELETE FROM portal_mfa_challenges WHERE expires_at < now()');
  await rows('DELETE FROM portal_email_codes WHERE expires_at < now()');
  await rows('DELETE FROM trusted_devices WHERE expires_at < now()');
  await rows("UPDATE bids SET status=3,updated_at=now() WHERE status=0 AND (expiry_date<current_date OR expires_at<now())");
  console.log('Expired sessions, rate limits, and bids cleaned up');
}
cleanup().catch(error => { console.error(error.message); process.exitCode=1; }).finally(closePool);
