import type {EmailProviderCapabilities, EmailSendErrorKind, OutboundEmailMessage} from '@plunk/types';

/**
 * A provider-agnostic error thrown by EmailProvider.send(). Every implementation
 * must map its own SDK/library errors onto one of the concrete subclasses below —
 * nothing upstream (the worker, retry/backoff logic) should ever inspect a
 * provider-specific error type (AWS SDK error codes, nodemailer error codes, ...).
 */
export class EmailSendError extends Error {
  public readonly kind: EmailSendErrorKind;
  public readonly cause?: unknown;

  constructor(kind: EmailSendErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = 'EmailSendError';
    this.kind = kind;
    this.cause = cause;
  }
}

/** Bad address, message rejected outright — SMTP 5xx, SES MessageRejected. Not retryable. */
export class PermanentSendError extends EmailSendError {
  constructor(message: string, cause?: unknown) {
    super('permanent', message, cause);
    this.name = 'PermanentSendError';
  }
}

/** Network blip, SMTP 4xx greylisting, etc. Safe to retry via the existing BullMQ backoff. */
export class TransientSendError extends EmailSendError {
  constructor(message: string, cause?: unknown) {
    super('transient', message, cause);
    this.name = 'TransientSendError';
  }
}

/** Provider is throttling us (SES Throttling/TooManyRequests, SMTP 421). Retry without
 * burning a retry attempt — see RateLimiterService / the worker's moveToDelayed handling. */
export class ThrottledSendError extends EmailSendError {
  constructor(message: string, cause?: unknown) {
    super('throttled', message, cause);
    this.name = 'ThrottledSendError';
  }
}

/** Bad credentials / access denied — an operator-config problem, not a per-email one.
 * Every subsequent send from this project will fail identically until fixed. */
export class ProviderAuthError extends EmailSendError {
  constructor(message: string, cause?: unknown) {
    super('auth', message, cause);
    this.name = 'ProviderAuthError';
  }
}

export interface EmailProvider {
  readonly type: 'SES' | 'SMTP';
  readonly capabilities: EmailProviderCapabilities;

  /** Send a single email. Resolves with the provider's message ID, or throws an EmailSendError subclass. */
  send(message: OutboundEmailMessage): Promise<{messageId: string}>;

  /** Max sustainable sends/second for this provider right now. SES: derived from the
   * live AWS quota (cached). SMTP: the project's static configured/default limit. */
  getThroughput(): Promise<{maxPerSecond: number}>;
}
