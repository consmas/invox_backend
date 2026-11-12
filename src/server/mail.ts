import nodemailer from 'nodemailer';
import { ApiError } from './errors';
import { activeIntegration, mailFrom, smtpTransport } from './integrations';

export function appUrl() {
  const url = process.env.APP_URL;
  if (!url && process.env.NODE_ENV === 'production') throw new ApiError(503, 'APP_URL is not configured');
  return url || 'http://localhost:3000';
}
/**
 * Outgoing mail uses the SMTP settings saved in Platform settings → Email when switched on, otherwise the
 * SMTP_URL / MAIL_FROM environment variables. Null means no mail server is configured.
 */
async function mailer(): Promise<{ send: (message: { to: string; subject: string; text: string }) => Promise<unknown> } | null> {
  const smtp = await activeIntegration('smtp');
  if (smtp) {
    const transport = smtpTransport(smtp.config, smtp.secrets);
    return { send: message => transport.sendMail({ from: mailFrom(smtp.config), replyTo: smtp.config.reply_to || undefined, ...message }) };
  }
  if (process.env.SMTP_URL) {
    const transport = nodemailer.createTransport(process.env.SMTP_URL);
    return { send: message => transport.sendMail({ from: process.env.MAIL_FROM || 'Invoix <no-reply@localhost>', ...message }) };
  }
  return null;
}
export async function requireMailConfiguration() {
  if (process.env.NODE_ENV === 'production' && !(await activeIntegration('smtp')) && (!process.env.SMTP_URL || !process.env.MAIL_FROM)) {
    throw new ApiError(503, 'Email delivery is not configured');
  }
}
export async function sendLink(email: string, subject: string, url: string): Promise<{ preview_url?: string }> {
  await requireMailConfiguration();
  const mail = await mailer();
  if (!mail) {
    // Link previews exist for local development only; any other environment must deliver real email.
    if (!['development', 'test'].includes(process.env.NODE_ENV ?? '')) throw new ApiError(503, 'Email delivery is not configured');
    return { preview_url: url };
  }
  await mail.send({ to: email, subject, text: `${subject}\n\n${url}\n\nIf you did not request this, you can ignore this email.` });
  return {};
}
/** Informational notice email. Without a mail server it is skipped: the in-app notification is the record. */
export async function sendNotice(email: string, subject: string, text: string): Promise<void> {
  const mail = await mailer();
  if (!mail) return;
  await mail.send({ to: email, subject, text: `${text}\n\nSign in to INVOX to review the change. If you did not expect this, contact INVOX operations.` });
}
