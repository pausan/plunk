/**
 * Email sending provider types
 * Shared between the provider abstraction (apps/api) and the dashboard (apps/web)
 */

import type {SendingProviderType} from '@plunk/db';

/**
 * A single outbound message, provider-agnostic. Mirrors the params AWS SES's
 * sendRawEmail already accepts, plus the emailId (needed for synchronous-bounce
 * recording and native-tracking pixel/link injection on the SMTP path).
 */
export interface OutboundEmailMessage {
  emailId: string;
  from: {name: string; email: string};
  to: string[] | {name?: string; email: string}[];
  content: {subject: string; html: string};
  reply?: string;
  headers?: Record<string, string> | null;
  attachments?:
    | {
        filename: string;
        content: string; // Base64 encoded
        contentType: string;
        contentId?: string;
        disposition?: 'attachment' | 'inline';
      }[]
    | null;
  tracking?: boolean;
}

/**
 * What a given EmailProvider implementation can/can't do, so callers (the
 * worker, DomainService, the rate limiter) branch on capability rather than
 * provider identity.
 */
export interface EmailProviderCapabilities {
  requiresDomainVerification: boolean; // SES: true, SMTP: false
  supportsDynamicQuota: boolean; // SES: true (getSendQuota), SMTP: false (static config)
  injectsNativeTracking: boolean; // SES: false (provider-side), SMTP: true (Plunk injects pixel/links)
  supportsDeliveryConfirmation: boolean; // SES: true (SNS Delivery event), SMTP: false — status caps at SENT
}

/**
 * Error classification every EmailProvider implementation must map its own
 * SDK/library errors onto, so the worker never inspects provider-specific error types.
 */
export type EmailSendErrorKind = 'permanent' | 'transient' | 'throttled' | 'auth';

/**
 * Masked SMTP config DTO — returned by the sending-provider settings API and
 * rendered by the dashboard. Never includes the encrypted password/IV/authTag.
 */
export interface SmtpConfigPublic {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  fromOverride: string | null;
  maxSendRatePerSecond: number;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  configured: true;
}

export interface SendingProviderSettings {
  sendingProvider: SendingProviderType;
  sendingProviderMisconfigured: boolean;
  smtpConfig: SmtpConfigPublic | null;
}

/**
 * Body for PATCH /sending-provider/:projectId
 */
export interface UpdateSendingProviderInput {
  sendingProvider: SendingProviderType;
  smtpConfig?: {
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password?: string; // omitted on update = keep the existing encrypted password
    fromOverride?: string | null;
    maxSendRatePerSecond?: number;
  };
}

/**
 * Body for POST /sending-provider/:id/test
 */
export interface TestSmtpConnectionInput {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  // Optional — testing an already-saved config without retyping the password
  password?: string;
}

export interface TestSmtpConnectionResult {
  ok: boolean;
  error?: string;
}
