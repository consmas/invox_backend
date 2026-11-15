import { newToken, digest } from '../auth';
import { rows, transaction, type Row } from '../db';
import { appUrl, mailConfigured, sendNotice } from '../mail';
import { sendSms } from '../integrations';
import { notify, notifyContact } from '../portal-support';
import { template } from './supplier';

/**
 * The onboarding diary, run on a schedule by `pnpm db:cleanup` (SRS §13.4 "no item may expire unnoticed"):
 *  - onboarding stalled: the supplier is reminded on the channel it responded on, the inviting anchor sees the stage;
 *    reminders follow the configured schedule and stop as soon as the supplier progresses (S notifications matrix);
 *  - periodic re-verification and re-screening come due by risk rating (FR-ONB-004/007, FR-JNY-A-005/026);
 *  - expired filed documents raise a task (A2.7).
 */
async function setting<T>(key: string): Promise<T> { const [row] = await rows('SELECT value FROM onboarding_settings WHERE key=$1', [key]); return row?.value as T; }
async function task(orgRef: string, summary: string) {
  await rows(`INSERT INTO portal_exceptions(org_ref,kind,summary,status) SELECT $1,'COMPLIANCE_REVIEW',$2,'OPEN'
    WHERE NOT EXISTS(SELECT 1 FROM portal_exceptions WHERE org_ref=$1 AND status<>'RESOLVED' AND summary=$2)`, [orgRef, summary]);
}
const STEP: Record<string, string> = { INVITED: 'creating your log-in', REGISTERED: 'your verification', INFO_REQUIRED: 'the information we asked for' };

export async function onboardingReminders(now = new Date()) {
  const schedule = (await setting<number[]>('onboarding_reminder_days')) ?? [3, 7, 14];
  const due = await rows(`SELECT e.programme_id,e.supplier_id,e.reminders_sent,e.invited_by,e.responded_channel,s.name,s.email,s.contact_phone,s.user_id,s.preferred_channel,l.status,
      greatest(l.updated_at,e.created_at) AS since,b.name AS anchor,p.buyer_id
    FROM programme_enrolments e JOIN suppliers s ON s.id=e.supplier_id JOIN organisation_lifecycle l ON l.org_ref='supplier-'||s.id AND NOT l.legacy
    JOIN programmes p ON p.id=e.programme_id JOIN buyers b ON b.id=p.buyer_id
    WHERE e.status='PENDING_ENROLMENT' AND l.status IN ('INVITED','REGISTERED','INFO_REQUIRED') AND s.archived_at IS NULL`);
  let sent = 0;
  for (const row of due) {
    // Progress resets the schedule: count reminders only since the supplier's last step.
    const index = Number(row.reminders_sent);
    if (index >= schedule.length) continue;
    const ageDays = (now.getTime() - new Date(row.since).getTime()) / 86400000;
    if (ageDays < schedule[index]) continue;
    let link = `${appUrl()}/onboarding`;
    if (row.status === 'INVITED') {
      // The original link may have expired: a reminder carries a fresh single-use link and supersedes the old one.
      const token = newToken();
      const [days] = await rows("SELECT (value->>'SUPPLIER')::int AS days FROM onboarding_settings WHERE key='invitation_validity_days'");
      await rows('UPDATE suppliers SET invitation_token=$2,invitation_expires_at=now()+make_interval(days => $3),updated_at=now() WHERE id=$1', [row.supplier_id, digest(token), days?.days ?? 7]);
      link = `${appUrl()}/invite?token=${token}`;
    }
    const channel = (row.preferred_channel ?? row.responded_channel) === 'sms' || !row.email ? 'sms' : 'email';
    const message = await template('onboarding_reminder', channel, { anchor: row.anchor, link: channel === 'sms' ? `${link}${link.includes('?') ? '&' : '?'}via=sms` : link, remaining: STEP[row.status] ?? 'one step' });
    if (channel === 'sms') {
      let failure: string | null = null;
      try { await sendSms([row.contact_phone], message.body); } catch (error) { failure = (error as Error).message; }
      await rows(`INSERT INTO notifications(recipient,event_type,channel,subject,body,status,org_ref,delivery_attempts,delivered_at,last_error) VALUES($1,'onboarding_reminder','sms','Onboarding reminder',$2,$3::varchar,$4,1,CASE WHEN $3::varchar='delivered' THEN now() END,$5)`,
        [row.contact_phone, message.body, failure ? 'failed' : 'delivered', `supplier-${row.supplier_id}`, failure]);
    }
    await transaction(async db => {
      // Email reminders go through the notification queue, so they are retried and logged like every other notice.
      if (channel === 'email') await notifyContact(row.email, message.subject, message.body, null, db, `supplier-${row.supplier_id}`, 'onboarding_reminder');
      if (row.user_id) await notify(String(row.user_id), 'Finish setting up INVOX', `Continue with ${STEP[row.status] ?? 'your set-up'} to get paid early by ${row.anchor}.`, null, null, db, { orgRef: `supplier-${row.supplier_id}`, eventType: 'onboarding_reminder' });
      // The anchor's recruitment owner sees which step is outstanding — never documents or reasons.
      if (row.invited_by) await notify(String(row.invited_by), 'Supplier onboarding stalled', `${row.name} has not finished ${STEP[row.status] === 'creating your log-in' ? 'creating its log-in' : row.status === 'INFO_REQUIRED' ? 'providing requested information' : 'its verification'}. A reminder was sent.`, null, null, db, { eventType: 'onboarding_reminder' });
      await rows('UPDATE programme_enrolments SET reminders_sent=reminders_sent+1,last_reminded_at=now() WHERE programme_id=$1 AND supplier_id=$2', [row.programme_id, row.supplier_id], db);
    });
    sent++;
  }
  // A supplier that moved on since its last reminder starts the schedule afresh at its new step.
  await rows(`UPDATE programme_enrolments e SET reminders_sent=0 FROM organisation_lifecycle l
    WHERE l.org_ref='supplier-'||e.supplier_id AND e.last_reminded_at IS NOT NULL AND l.updated_at > e.last_reminded_at AND e.reminders_sent>0`);
  return sent;
}

export async function complianceDiary() {
  const rescreen = (await setting<Record<string, number>>('rescreening_months')) ?? { low: 12, medium: 12, high: 6 };
  // Periodic re-verification (A2.7, FR-JNY-A-026): a compliance task, and the organisation's administrators are told.
  for (const org of await rows(`SELECT org_ref,re_verification_due FROM organisation_lifecycle WHERE NOT legacy AND re_verification_due < current_date AND status NOT IN ('DECLINED','CLOSED','SETUP_ABANDONED')`)) {
    const summary = `Periodic re-verification due since ${String(org.re_verification_due).slice(0, 10)}`;
    const [open] = await rows("SELECT 1 FROM portal_exceptions WHERE org_ref=$1 AND status<>'RESOLVED' AND summary=$2", [org.org_ref, summary]);
    if (open) continue;
    await task(org.org_ref, summary);
    await notifyAdministrators(org, 'Re-verification due', 'INVOX needs to refresh your organisation’s verification. Your relationship manager will tell you what is required; until it is complete, new financing may be suspended.');
  }
  // Ongoing screening (FR-ONB-004, FR-JNY-A-005): every verified party is re-screened on its risk-based cycle.
  for (const org of await rows(`SELECT l.org_ref,l.risk_rating,max(s.screened_at) AS last FROM organisation_lifecycle l LEFT JOIN party_screenings s ON s.org_ref=l.org_ref
      WHERE NOT l.legacy AND l.status IN ('VERIFIED','CONFIGURED','PENDING_ACTIVATION','ACTIVE','SUSPENDED') GROUP BY l.org_ref,l.risk_rating`)) {
    const months = rescreen[org.risk_rating ?? 'high'] ?? 6;
    if (org.last && new Date(org.last).getTime() > Date.now() - months * 30.44 * 86400000) continue;
    await task(org.org_ref, `Re-screening due (every ${months} months for ${org.risk_rating ?? 'unrated'} risk)`);
  }
  // Expired filed documents (A2.7): one task per item until a current document is filed.
  for (const doc of await rows(`SELECT DISTINCT c.org_ref,c.item_key FROM compliance_documents c WHERE c.removed_at IS NULL AND c.expires_on < current_date
      AND NOT EXISTS(SELECT 1 FROM compliance_documents n WHERE n.org_ref=c.org_ref AND n.item_key=c.item_key AND n.removed_at IS NULL AND (n.expires_on IS NULL OR n.expires_on >= current_date))`))
    await task(doc.org_ref, `Compliance document expired: ${doc.item_key}`);
}
async function notifyAdministrators(org: Row, subject: string, body: string) {
  const [kind, key] = String(org.org_ref).split('-');
  const users = await rows(`SELECT id FROM users WHERE disabled_at IS NULL AND provisioning_status='ACTIVE' AND (org_ref=$1 OR ${kind === 'buyer' ? 'buyer_id=$2' : 'id=$2'}) AND coalesce(org_role,'administrator') IN ('administrator','relationship_owner')`, [org.org_ref, kind === 'supplier' ? ((await rows('SELECT user_id FROM suppliers WHERE id=$1', [key]))[0]?.user_id ?? 0) : key]);
  await transaction(async db => { for (const user of users) await notify(String(user.id), subject, body, null, null, db, { orgRef: org.org_ref, eventType: 're_verification' }); });
}

/** Sends queued email notifications with retry and back-off; every attempt is recorded on the notification (§13.4). */
export async function dispatchNotifications(limit = 200) {
  let delivered = 0;
  // Without a mail server nothing is sent: production keeps the queue for later; elsewhere the items are marked skipped.
  if (!(await mailConfigured())) {
    if (process.env.NODE_ENV === 'production') return { attempted: 0, delivered: 0, waiting: true };
    await rows("UPDATE notifications SET status='skipped',last_error='No mail server configured',updated_at=now() WHERE channel='email' AND status='queued'");
    return { attempted: 0, delivered: 0 };
  }
  const batch = await transaction(async db => rows(`UPDATE notifications SET status='sending',updated_at=now() WHERE id IN (
      SELECT id FROM notifications WHERE channel='email' AND status='queued' AND coalesce(next_attempt_at,now())<=now() ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
    RETURNING notifications.*,(SELECT email FROM users u WHERE u.id=notifications.user_id) AS user_email`, [limit], db));
  for (const item of batch) {
    const address = item.recipient ?? item.user_email;
    try {
      if (!address) throw new Error('No email address on record');
      await sendNotice(address, item.subject, item.body);
      await rows("UPDATE notifications SET status='delivered',delivered_at=now(),delivery_attempts=coalesce(delivery_attempts,0)+1,last_error=NULL,updated_at=now() WHERE id=$1", [item.id]);
      delivered++;
    } catch (error) {
      const attempts = Number(item.delivery_attempts ?? 0) + 1;
      await rows(`UPDATE notifications SET status=CASE WHEN $2>=6 THEN 'failed' ELSE 'queued' END,delivery_attempts=$2,last_error=$3,next_attempt_at=now()+make_interval(mins => $4),updated_at=now() WHERE id=$1`, [item.id, attempts, (error as Error).message.slice(0, 500), 2 ** attempts]);
    }
  }
  return { attempted: batch.length, delivered };
}
