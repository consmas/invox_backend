import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { type Actor, privilegedMfaRequired } from './auth';
import { rows, transaction, type DB, type Row } from './db';
import { ApiError, requireCondition } from './errors';
import { email } from './validation';
import { portalEvent } from './portal-support';

/**
 * Live integrations: SMTP email, mNotify SMS and the payment providers (Paystack, Flutterwave, GhIPSS GIP).
 * Operations can see the settings; only the super administrator can change or test them. Credentials are
 * sealed with AES-256-GCM, are write-only through the API, and are never logged or returned.
 */
export const PROVIDERS = ['smtp', 'mnotify', 'paystack', 'flutterwave', 'ghipss', 'payment_routing'] as const;
export type Provider = typeof PROVIDERS[number];
const PAYMENT_PROVIDERS = ['paystack', 'flutterwave', 'ghipss'] as const;
const currency = z.enum(['GHS', 'NGN', 'KES', 'USD', 'ZAR']);
const text = (max: number) => z.string().trim().max(max);
const httpsUrl = z.string().trim().url('Enter a full https:// address').refine(value => value.startsWith('https://'), 'The address must use https://').max(500);

const definitions: Record<Provider, { config: z.ZodObject<z.ZodRawShape>; secrets: string[]; required: string[] }> = {
  smtp: {
    config: z.object({
      host: text(255).min(1, 'Enter the SMTP server host'),
      port: z.coerce.number().int().min(1).max(65535),
      security: z.enum(['tls', 'starttls', 'none']),
      username: text(255).default(''),
      from_name: text(100).min(1, 'Enter the sender name'),
      from_email: email,
      reply_to: z.union([email, z.literal('')]).default(''),
    }),
    secrets: ['password'], required: [],
  },
  mnotify: {
    config: z.object({ sender_id: z.string().trim().regex(/^[A-Za-z0-9 ]{3,11}$/, 'Sender ID must be 3 to 11 letters or digits, as approved by mNotify') }),
    secrets: ['api_key'], required: ['api_key'],
  },
  paystack: {
    config: z.object({ public_key: z.string().trim().regex(/^pk_(test|live)_[A-Za-z0-9]+$/, 'Paystack public keys start with pk_test_ or pk_live_'), currency }),
    secrets: ['secret_key'], required: ['secret_key'],
  },
  flutterwave: {
    config: z.object({ public_key: z.string().trim().regex(/^FLWPUBK(_TEST)?-[A-Za-z0-9]+-X$/, 'Flutterwave public keys start with FLWPUBK_TEST- or FLWPUBK-'), currency }),
    secrets: ['secret_key', 'encryption_key', 'webhook_hash'], required: ['secret_key', 'encryption_key'],
  },
  ghipss: {
    config: z.object({
      partner_name: text(200).min(2, 'Enter the participant bank or aggregator providing GIP access'),
      base_url: httpsUrl,
      participant_code: text(50).min(1, 'Enter the institution / participant code'),
      client_id: text(200).default(''),
      settlement_bank_code: text(20).min(1, 'Enter the settlement bank code'),
      settlement_account_number: z.string().trim().regex(/^\d{6,20}$/, 'Enter the settlement account number (digits only)'),
      settlement_account_name: text(200).min(2, 'Enter the settlement account name'),
      name_enquiry: z.boolean().default(true),
    }),
    secrets: ['client_secret', 'api_key'], required: ['client_secret'],
  },
  payment_routing: {
    config: z.object({ collections: z.enum(['none', ...PAYMENT_PROVIDERS]), disbursements: z.enum(['none', ...PAYMENT_PROVIDERS]) }),
    secrets: [], required: [],
  },
};

/** Same rule as acting for organisations: the seeded super administrator, authenticator verified. */
async function requireSuperAdmin(actor: Actor) {
  const [user] = actor.role === 'platform_ops' && !actor.delegation ? await rows('SELECT super_admin FROM users WHERE id=$1 AND disabled_at IS NULL', [actor.id]) : [];
  requireCondition(user?.super_admin, 403, 'Only the super administrator can change integration settings');
  requireCondition(!privilegedMfaRequired(actor), 403, 'Verify your authenticator before changing integration settings');
}

// ── sealed credentials ───────────────────────────────────────────────────────
/** A dedicated key (SETTINGS_ENCRYPTION_KEY), or one derived from MFA_SECRET_KEY so the two never share key material. */
function key(): Buffer {
  const dedicated = process.env.SETTINGS_ENCRYPTION_KEY;
  if (dedicated) { requireCondition(/^[a-f0-9]{64}$/i.test(dedicated), 503, 'SETTINGS_ENCRYPTION_KEY must be 64 hexadecimal characters'); return Buffer.from(dedicated, 'hex'); }
  const base = process.env.MFA_SECRET_KEY;
  requireCondition(base && /^[a-f0-9]{64}$/i.test(base), 503, 'Set SETTINGS_ENCRYPTION_KEY (or MFA_SECRET_KEY) before storing integration credentials');
  return Buffer.from(hkdfSync('sha256', Buffer.from(base, 'hex'), Buffer.alloc(0), 'invox-integration-settings', 32));
}
function seal(value: Record<string, string>) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
function unseal(value: string | null): Record<string, string> {
  if (!value) return {};
  const data = Buffer.from(value, 'base64'); const decipher = createDecipheriv('aes-256-gcm', key(), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'));
}
const hint = (secret: string) => `••••${secret.slice(-4)}`;

// ── storage ──────────────────────────────────────────────────────────────────
async function load(provider: Provider, db?: DB, lock = false): Promise<Row> {
  const [row] = await rows(`SELECT * FROM integration_settings WHERE provider=$1${lock ? ' FOR UPDATE' : ''}`, [provider], db);
  return row ?? { provider, enabled: false, mode: 'test', config: {}, secrets_sealed: null, secret_hints: {} };
}
/** Settings and credentials for runtime use, or null when the integration is switched off. */
export async function activeIntegration(provider: Provider, db?: DB): Promise<{ mode: string; config: Row; secrets: Record<string, string> } | null> {
  const row = await load(provider, db).catch(() => null);
  if (!row?.enabled) return null;
  // A missing or rotated encryption key must not stop every email: callers fall back to the environment settings.
  try { return { mode: row.mode, config: row.config, secrets: unseal(row.secrets_sealed) }; }
  catch (error) { console.error(`Stored ${provider} credentials could not be decrypted`, (error as Error).message); return null; }
}
function view(row: Row, canEdit: boolean) {
  const definition = definitions[row.provider as Provider];
  return {
    provider: row.provider, enabled: row.enabled, mode: row.mode, config: row.config, can_edit: canEdit,
    secrets: Object.fromEntries(definition.secrets.map(name => [name, { set: !!row.secret_hints?.[name], hint: row.secret_hints?.[name] ?? null, required: definition.required.includes(name) }])),
    updated_at: row.updated_at ?? null, last_tested_at: row.last_tested_at ?? null, last_test_ok: row.last_test_ok ?? null, last_test_message: row.last_test_message ?? null,
  };
}

/** Keys must match the mode, so a live switch can never silently run on test credentials (or the reverse). */
function checkMode(provider: Provider, mode: string, config: Row, secrets: Record<string, string>) {
  const live = mode === 'live';
  if (provider === 'paystack') {
    if (config.public_key) requireCondition(config.public_key.startsWith(live ? 'pk_live_' : 'pk_test_'), 422, `Use a Paystack ${mode} public key (pk_${mode}_…)`);
    if (secrets.secret_key) requireCondition(secrets.secret_key.startsWith(live ? 'sk_live_' : 'sk_test_'), 422, `Use a Paystack ${mode} secret key (sk_${mode}_…)`);
  }
  if (provider === 'flutterwave') {
    if (config.public_key) requireCondition(live ? !config.public_key.startsWith('FLWPUBK_TEST-') : config.public_key.startsWith('FLWPUBK_TEST-'), 422, `Use a Flutterwave ${mode} public key`);
    if (secrets.secret_key) requireCondition(live ? /^FLWSECK-/.test(secrets.secret_key) : /^FLWSECK_TEST-/.test(secrets.secret_key), 422, `Use a Flutterwave ${mode} secret key (${live ? 'FLWSECK-' : 'FLWSECK_TEST-'}…)`);
  }
}

const updateInput = z.object({
  enabled: z.boolean(),
  mode: z.enum(['test', 'live']).default('test'),
  config: z.record(z.string(), z.unknown()).default({}),
  /** Only fields being changed; blank keeps the stored credential. */
  secrets: z.record(z.string(), z.string().max(4000)).default({}),
  clear_secrets: z.array(z.string()).default([]),
}).strict();

async function save(actor: Actor, provider: Provider, body: unknown) {
  await requireSuperAdmin(actor);
  const definition = definitions[provider];
  const input = updateInput.parse(body);
  for (const name of [...Object.keys(input.secrets), ...input.clear_secrets]) requireCondition(definition.secrets.includes(name), 422, `Unknown credential: ${name}`);
  return transaction(async db => {
    const current = await load(provider, db, true);
    // Disabled integrations may be saved part-complete; switching one on needs every required setting.
    const config = (input.enabled ? definition.config : definition.config.partial()).parse({ ...input.config });
    const secrets = { ...unseal(current.secrets_sealed) };
    for (const [name, value] of Object.entries(input.secrets)) if (value.trim()) secrets[name] = value.trim();
    for (const name of input.clear_secrets) delete secrets[name];
    checkMode(provider, input.mode, config, secrets);
    if (input.enabled) for (const name of definition.required) requireCondition(secrets[name], 422, `Enter the ${name.replaceAll('_', ' ')} before switching this integration on`);
    if (provider === 'payment_routing') for (const target of [config.collections, config.disbursements]) if (target && target !== 'none') requireCondition((await load(target as Provider, db)).enabled, 422, `Switch on ${target} before routing payments to it`);
    if (PAYMENT_PROVIDERS.includes(provider as typeof PAYMENT_PROVIDERS[number]) && !input.enabled) {
      const routing = await load('payment_routing', db);
      requireCondition(!routing.enabled || ![routing.config.collections, routing.config.disbursements].includes(provider), 409, 'Route payments to another provider before switching this one off');
    }
    const hints = Object.fromEntries(Object.entries(secrets).map(([name, value]) => [name, hint(value)]));
    const changed = JSON.stringify(current.config) !== JSON.stringify(config) || current.mode !== input.mode || Object.keys(input.secrets).some(name => input.secrets[name].trim()) || input.clear_secrets.length > 0;
    const [row] = await rows(`INSERT INTO integration_settings(provider,enabled,mode,config,secrets_sealed,secret_hints,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,now())
      ON CONFLICT(provider) DO UPDATE SET enabled=$2,mode=$3,config=$4,secrets_sealed=$5,secret_hints=$6,updated_by=$7,updated_at=now(),
      last_tested_at=CASE WHEN $8 THEN NULL ELSE integration_settings.last_tested_at END,last_test_ok=CASE WHEN $8 THEN NULL ELSE integration_settings.last_test_ok END,last_test_message=CASE WHEN $8 THEN NULL ELSE integration_settings.last_test_message END RETURNING *`,
      [provider, input.enabled, input.mode, JSON.stringify(config), Object.keys(secrets).length ? seal(secrets) : null, JSON.stringify(hints), actor.id, changed], db);
    // The audit trail names what changed, never credential values.
    await portalEvent(actor, 'integration.updated', null, null, { provider, enabled: input.enabled, mode: input.mode, config_keys: Object.keys(config), credentials_changed: [...Object.keys(input.secrets).filter(name => input.secrets[name].trim()), ...input.clear_secrets] }, db);
    return view(row, true);
  });
}

// ── connection tests ─────────────────────────────────────────────────────────
const TIMEOUT = 10_000;
async function json(url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body: body as Row };
}
export function smtpTransport(config: Row, secrets: Record<string, string>) {
  return nodemailer.createTransport({
    host: config.host, port: Number(config.port), secure: config.security === 'tls', requireTLS: config.security === 'starttls', ignoreTLS: config.security === 'none',
    auth: config.username ? { user: config.username, pass: secrets.password ?? '' } : undefined,
    connectionTimeout: TIMEOUT, greetingTimeout: TIMEOUT, socketTimeout: TIMEOUT,
  });
}
export const mailFrom = (config: Row) => `${String(config.from_name).replace(/["<>\r\n]/g, '')} <${config.from_email}>`;
const MNOTIFY = 'https://api.mnotify.com/api';
/** Ghana numbers in local (024…) or international (+233…) form, as mNotify expects. */
export const smsNumber = (value: string) => { const digits = value.replace(/[^\d]/g, ''); return digits.startsWith('0') ? `233${digits.slice(1)}` : digits; };

/** Sends an SMS through mNotify. Throws when SMS is switched off or mNotify refuses the message. */
export async function sendSms(to: string[], message: string) {
  const sms = await activeIntegration('mnotify');
  requireCondition(sms, 503, 'SMS is not configured');
  const recipients = to.map(smsNumber).filter(number => /^\d{9,15}$/.test(number));
  requireCondition(recipients.length, 422, 'Enter a valid phone number');
  const result = await json(`${MNOTIFY}/sms/quick?key=${encodeURIComponent(sms.secrets.api_key)}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ recipient: recipients, sender: sms.config.sender_id, message: message.slice(0, 459), is_schedule: false, schedule_date: '' }) });
  requireCondition(result.ok && result.body.status === 'success', 502, `mNotify did not accept the message${result.body.message ? `: ${result.body.message}` : ''}`);
  return { recipients: recipients.length };
}

async function test(provider: Provider, row: Row, input: Row): Promise<string> {
  const config = row.config; const secrets = unseal(row.secrets_sealed);
  if (provider === 'smtp') {
    definitions.smtp.config.parse(config);
    const transport = smtpTransport(config, secrets);
    await transport.verify();
    if (input.to) {
      const to = email.parse(input.to);
      await transport.sendMail({ from: mailFrom(config), to, replyTo: config.reply_to || undefined, subject: 'INVOX email settings test', text: 'This is a test message from INVOX. Your SMTP settings are working.' });
      return `Connected to ${config.host} and sent a test email to ${to}.`;
    }
    return `Connected to ${config.host} and signed in successfully.`;
  }
  if (provider === 'mnotify') {
    requireCondition(secrets.api_key, 422, 'Enter the mNotify API key first');
    const balance = await json(`${MNOTIFY}/balance/sms?key=${encodeURIComponent(secrets.api_key)}`, { headers: { Accept: 'application/json' } });
    requireCondition(balance.ok && balance.body.status === 'success', 502, 'mNotify rejected the API key');
    if (input.to) {
      requireCondition(row.enabled, 409, 'Switch SMS on before sending a test message');
      await sendSms([String(input.to)], 'INVOX test message: your SMS settings are working.');
      return `API key accepted (SMS balance ${balance.body.balance ?? 'available'}) and a test SMS was sent.`;
    }
    return `API key accepted. SMS balance: ${balance.body.balance ?? 'available'}.`;
  }
  if (provider === 'paystack') {
    requireCondition(secrets.secret_key, 422, 'Enter the Paystack secret key first');
    const result = await json('https://api.paystack.co/balance', { headers: { Authorization: `Bearer ${secrets.secret_key}`, Accept: 'application/json' } });
    requireCondition(result.ok && result.body.status === true, 502, `Paystack rejected the secret key${result.body.message ? `: ${result.body.message}` : ''}`);
    const currencies = (result.body.data as Row[] | undefined)?.map(entry => entry.currency).filter(Boolean) ?? [];
    return `Paystack ${row.mode} key accepted${currencies.length ? ` (balances in ${currencies.join(', ')})` : ''}.`;
  }
  if (provider === 'flutterwave') {
    requireCondition(secrets.secret_key, 422, 'Enter the Flutterwave secret key first');
    const result = await json('https://api.flutterwave.com/v3/balances', { headers: { Authorization: `Bearer ${secrets.secret_key}`, Accept: 'application/json' } });
    requireCondition(result.ok && result.body.status === 'success', 502, `Flutterwave rejected the secret key${result.body.message ? `: ${result.body.message}` : ''}`);
    return `Flutterwave ${row.mode} key accepted.`;
  }
  if (provider === 'ghipss') {
    // GIP access is through a participant bank or aggregator, each with its own API; only reachability is generic.
    const base = httpsUrl.parse(config.base_url);
    const res = await fetch(base, { method: 'GET', signal: AbortSignal.timeout(TIMEOUT) });
    return `Reached ${new URL(base).host} (HTTP ${res.status}). Authentication is confirmed with ${config.partner_name ?? 'your GIP partner'} during their certification test.`;
  }
  throw new ApiError(422, 'This setting has no connection test');
}

// ── API ──────────────────────────────────────────────────────────────────────
export async function integrationsRequest(actor: Actor, method: string, path: string[], body: Row): Promise<{ status?: number; data?: unknown }> {
  requireCondition(actor.role === 'platform_ops' && !actor.delegation, 403, 'Integration settings are managed by operations');
  const [, , rawProvider, action] = path;
  if (method === 'GET' && !rawProvider) {
    let canEdit = true; try { await requireSuperAdmin(actor); } catch { canEdit = false; }
    const stored = await rows('SELECT * FROM integration_settings');
    return { data: PROVIDERS.map(provider => view(stored.find(row => row.provider === provider) ?? { provider, enabled: false, mode: 'test', config: {}, secret_hints: {} }, canEdit)) };
  }
  const provider = z.enum(PROVIDERS).parse(rawProvider);
  if (method === 'PUT' && !action) return { data: await save(actor, provider, body) };
  if (method === 'POST' && action === 'test') {
    await requireSuperAdmin(actor);
    const row = await load(provider);
    let ok = true; let message: string;
    try { message = await test(provider, row, body); }
    catch (error) { ok = false; message = error instanceof ApiError || error instanceof z.ZodError ? (error instanceof z.ZodError ? 'Complete the required settings first' : error.message) : `Connection failed: ${(error as Error).message}`; }
    await rows('INSERT INTO integration_settings(provider,last_tested_at,last_test_ok,last_test_message) VALUES($1,now(),$2,$3) ON CONFLICT(provider) DO UPDATE SET last_tested_at=now(),last_test_ok=$2,last_test_message=$3', [provider, ok, message]);
    await portalEvent(actor, 'integration.tested', null, null, { provider, ok });
    return { data: { ok, message } };
  }
  throw new ApiError(404, 'Integration endpoint not found');
}
