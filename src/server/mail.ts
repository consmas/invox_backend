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
  if (!process.env.SMTP_URL) return { preview_url: url }; // Returned only to the authorized caller in development.
  await nodemailer.createTransport(process.env.SMTP_URL).sendMail({
    from: process.env.MAIL_FROM || 'Invoix <no-reply@localhost>', to: email, subject,
    text: `${subject}\n\n${url}\n\nIf you did not request this, you can ignore this email.`,
  });
  return {};
}
