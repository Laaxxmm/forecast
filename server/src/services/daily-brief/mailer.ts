// Outlook / Office 365 SMTP transport for the Daily Brief.
//
// Configuration is env-only (we never persist credentials to the DB):
//   SMTP_HOST       defaults to smtp.office365.com
//   SMTP_PORT       defaults to 587
//   SMTP_USER       the sending mailbox (e.g. finance@indefine.in)
//   SMTP_PASS       a 16-char "app password" generated at
//                   https://mysignins.microsoft.com/security-info — required
//                   when MFA is on (which is the default for Microsoft 365)
//   SMTP_FROM_NAME  display name on the From header (default: "Indefine")
//   SMTP_REPLY_TO   optional Reply-To address
//
// O365 enforces that the From address matches the authenticated mailbox
// (SMTP_USER), so we don't expose a separate SMTP_FROM_ADDRESS.

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

let cachedTransporter: Transporter | null = null;
let cachedConfigKey = '';

export interface MailerConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  fromName: string;
  fromAddress: string;
  replyTo?: string;
}

export function getMailerConfig(): MailerConfig | null {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) return null;
  return {
    host: process.env.SMTP_HOST || 'smtp.office365.com',
    port: Number(process.env.SMTP_PORT || 587),
    user,
    pass,
    fromName: process.env.SMTP_FROM_NAME || 'Indefine · Daily Dose',
    fromAddress: user,                            // O365 enforces this
    replyTo: process.env.SMTP_REPLY_TO || user,
  };
}

// Stable key for the active SMTP config — when env vars change between
// boots the cached transporter is rebuilt rather than holding stale auth.
function configKey(c: MailerConfig): string {
  return `${c.host}:${c.port}:${c.user}`;
}

function getTransporter(): Transporter | null {
  const cfg = getMailerConfig();
  if (!cfg) return null;
  const key = configKey(cfg);
  if (cachedTransporter && key === cachedConfigKey) return cachedTransporter;
  cachedTransporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,                     // 587 uses STARTTLS, 465 is implicit TLS
    requireTLS: cfg.port === 587,
    auth: { user: cfg.user, pass: cfg.pass },
    // Bounded timeouts — the verify() call on the Settings page used to
    // block until nodemailer's default ~10 min socket timeout if the
    // server couldn't reach smtp.office365.com. Five-second connect /
    // greet + ten-second socket are plenty for healthy O365 endpoints.
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 10_000,
    tls: {
      // Office 365 expects modern ciphers; let Node's defaults handle it.
      // Setting minVersion guards against legacy TLS warnings.
      minVersion: 'TLSv1.2',
    },
  });
  cachedConfigKey = key;
  return cachedTransporter;
}

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface SendOptions {
  to: string[];
  subject: string;
  html: string;
  text?: string;
  attachments?: MailAttachment[];
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  accepted?: string[];
  rejected?: string[];
  error?: string;
}

export async function sendMail(opts: SendOptions): Promise<SendResult> {
  const cfg = getMailerConfig();
  const transporter = getTransporter();
  if (!cfg || !transporter) {
    return { ok: false, error: 'SMTP credentials not configured (set SMTP_USER and SMTP_PASS).' };
  }
  if (opts.to.length === 0) {
    return { ok: false, error: 'No recipients.' };
  }
  try {
    const info = await transporter.sendMail({
      from: { name: cfg.fromName, address: cfg.fromAddress },
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      replyTo: cfg.replyTo,
      attachments: opts.attachments?.map(a => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    });
    return {
      ok: true,
      messageId: info.messageId,
      accepted: (info.accepted || []).map(String),
      rejected: (info.rejected || []).map(String),
    };
  } catch (err: any) {
    // Surface a clean message — nodemailer's errors are noisy and often
    // include the SMTP server response code which is the most useful bit.
    const code = err?.code || err?.responseCode || '';
    const msg = err?.message || String(err);
    return { ok: false, error: code ? `${code}: ${msg}` : msg };
  }
}

// Simple connection test for the Settings UI's "Send test" button — does
// nothing destructive, just opens a TLS handshake + AUTH and closes.
export async function verifyMailer(): Promise<{ ok: boolean; error?: string }> {
  const transporter = getTransporter();
  if (!transporter) return { ok: false, error: 'SMTP credentials not configured.' };
  try {
    await transporter.verify();
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}
