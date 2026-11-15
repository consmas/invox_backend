import { loadEnvConfig } from '@next/env';
import { closePool } from '../src/server/db';
import { dispatchNotifications } from '../src/server/onboarding/diary';

// Sends queued email notifications with retry. Schedule every minute or two (in addition to the hourly db:cleanup).
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');
dispatchNotifications().then(result => console.log(`Email notifications: ${result.delivered}/${result.attempted} delivered${'waiting' in result ? ' (no mail server configured yet; queue kept)' : ''}`))
  .catch(error => { console.error(error.message); process.exitCode = 1; }).finally(closePool);
