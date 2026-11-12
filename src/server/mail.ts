import nodemailer from 'nodemailer';
import { ApiError } from './errors';

export function appUrl() {
  const url = process.env.APP_URL;
  if (!url && process.env.NODE_ENV === 'production') throw new ApiError(503, 'APP_URL is not configured');
  return url || 'http://localhost:3000';
}
export function requireMailConfiguration() {
  if (process.env.NODE_ENV === 'production' && (!process.env.SMTP_URL || !process.env.MAIL_FROM)) {
    throw new ApiError(503, 'Email delivery is not configured');
  }
}
export async function sendLink(email: string, subject: string, url: string): Promise<{ preview_url?: string }> {
  requireMailConfiguration();
  if (!process.env.SMTP_URL) {
    // Link previews exist for local development only; any other environment must deliver real email.
    if (!['development', 'test'].includes(process.env.NODE_ENV ?? '')) throw new ApiError(503, 'Email delivery is not configured');
    return { preview_url: url };
  }
  await nodemailer.createTransport(process.env.SMTP_URL).sendMail({
    from: process.env.MAIL_FROM || 'Invoix <no-reply@localhost>', to: email, subject,
    text: `${subject}\n\n${url}\n\nIf you did not request this, you can ignore this email.`,
  });
  return {};
}
/** Informational notice email. Without SMTP configured it is skipped: the in-app notification is the record. */
export async function sendNotice(email: string, subject: string, text: string): Promise<void> {
  if (!process.env.SMTP_URL) return;
  await nodemailer.createTransport(process.env.SMTP_URL).sendMail({
    from: process.env.MAIL_FROM || 'Invoix <no-reply@localhost>', to: email, subject,
    text: `${text}\n\nSign in to INVOX to review the change. If you did not expect this, contact INVOX operations.`,
  });
}
