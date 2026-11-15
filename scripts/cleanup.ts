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
  // Re-verification diary (A2.7, FR-ONB-007): overdue reviews and expired filed documents become compliance tasks, once each.
  await rows(`INSERT INTO portal_exceptions(org_ref,kind,summary,status)
    SELECT l.org_ref,'COMPLIANCE_REVIEW','Periodic re-verification due since '||l.re_verification_due,'OPEN' FROM organisation_lifecycle l
    WHERE NOT l.legacy AND l.re_verification_due < current_date AND l.status NOT IN ('DECLINED','CLOSED','SETUP_ABANDONED')
      AND NOT EXISTS(SELECT 1 FROM portal_exceptions e WHERE e.org_ref=l.org_ref AND e.status<>'RESOLVED' AND e.summary LIKE 'Periodic re-verification due%')`);
  await rows(`INSERT INTO portal_exceptions(org_ref,kind,summary,status)
    SELECT DISTINCT c.org_ref,'COMPLIANCE_REVIEW','Compliance document expired: '||c.item_key,'OPEN' FROM compliance_documents c
    WHERE c.removed_at IS NULL AND c.expires_on < current_date
      AND NOT EXISTS(SELECT 1 FROM compliance_documents n WHERE n.org_ref=c.org_ref AND n.item_key=c.item_key AND n.removed_at IS NULL AND (n.expires_on IS NULL OR n.expires_on >= current_date))
      AND NOT EXISTS(SELECT 1 FROM portal_exceptions e WHERE e.org_ref=c.org_ref AND e.status<>'RESOLVED' AND e.summary='Compliance document expired: '||c.item_key)`);
  await rows("UPDATE bids SET status=3,updated_at=now() WHERE status=0 AND (expiry_date<current_date OR expires_at<now())");
  console.log('Expired sessions, rate limits, and bids cleaned up');
}
cleanup().catch(error => { console.error(error.message); process.exitCode=1; }).finally(closePool);
