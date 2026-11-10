import { z } from 'zod';
import { cents } from './money';

export const roles = ['buyer_admin', 'supplier_user', 'platform_ops', 'financer'] as const;
export type Role = typeof roles[number];
export const invoiceStatuses = ['draft', 'approved', 'tender', 'funded', 'repaid'] as const;
export const bidStatuses = ['pending', 'accepted', 'rejected', 'expired'] as const;
export const id = z.union([z.string(), z.number().int().positive().max(Number.MAX_SAFE_INTEGER)])
  .transform(String).pipe(z.string().regex(/^[1-9]\d{0,17}$/, 'Invalid ID'));
export const email = z.string().trim().toLowerCase().email().max(254);
export const password = z.string().min(10).max(72).refine(value => Buffer.byteLength(value, 'utf8') <= 72, 'Password must be at most 72 UTF-8 bytes');
export const money = z.union([z.string().regex(/^\d+(\.\d{1,2})?$/, 'Use a positive amount with at most two decimal places'), z.number().finite()])
  .transform(String).refine(value => {try{return cents(value)>BigInt(0)&&cents(value)<=BigInt('9999999999');}catch{return false;}}, 'Invalid amount');
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, 'Invalid date');
export const userInput = z.object({
  email, password: password.optional(), password_confirmation: z.string().optional(),
  role: z.enum(roles).default('supplier_user'), buyer_id: id.nullable().optional(),
  name:z.string().trim().max(200).nullable().optional(),contact_phone:z.string().trim().max(100).nullable().optional(),country:z.string().toUpperCase().regex(/^[A-Z]{2}$/).nullable().optional(),preferred_language:z.string().trim().max(50).nullable().optional(),timezone:z.string().trim().max(100).nullable().optional(),recert_cycle:z.coerce.number().int().min(1).max(120).optional(),
});
export const buyerInput = z.object({ name: z.string().trim().min(1).max(200), registration_number: z.string().trim().min(1).max(100),
  address: z.string().max(1000).default(''), contact_email: email });
export const programmeInput = z.object({ name: z.string().trim().min(1).max(200), limit: money,
  fee_percent: z.coerce.number().min(0).max(100), maturity_days: z.coerce.number().int().min(1).max(3650) });
export const invoiceInput = z.object({ programme_id: id, supplier_id: id, invoice_number: z.string().trim().max(100).nullable().optional(),
  amount: money, currency:z.enum(['GHS','USD','EUR','NGN','KES']).default('GHS'), due_date: date.nullable().optional(), status: z.enum(invoiceStatuses).default('draft') });
export const bidInput = z.object({ amount: money, expiry_date: date.nullable().optional() });
