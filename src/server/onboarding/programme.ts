import { rows, type DB, type Row } from '../db';
import { lifecycle } from './lifecycle';

/**
 * Release (A4.8) checks that exist so far. A new anchor can only have programmes released once its compliance file is
 * signed off (VERIFIED or later). Early-payment programmes additionally need funding facilities, which arrive with the
 * facility set-up (F2/F3); until then only tender programmes can be released. Organisations set up before the
 * onboarding checklist are not blocked.
 */
export async function programmeReleaseProblem(programme: Row, db: DB): Promise<string | null> {
  const anchor = await lifecycle(`buyer-${programme.buyer_id}`, db);
  if (anchor && !anchor.legacy && !['VERIFIED', 'CONFIGURED', 'PENDING_ACTIVATION', 'ACTIVE'].includes(anchor.status)) return 'Complete the anchor’s compliance sign-off before releasing its programme';
  if (programme.financing_model === 'early_payment') return 'Early-payment programmes need funding facilities, which are configured in the funder set-up; release this programme once its facilities are attached';
  if (!(await rows('SELECT 1 FROM portal_programme_financiers WHERE programme_id=$1', [programme.id], db)).length) return 'Add at least one financier before release';
  return null;
}
