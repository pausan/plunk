import type {EmailProviderCapabilities, OutboundEmailMessage} from '@plunk/types';
import nodemailer from 'nodemailer';

import type {EmailProvider} from './EmailProvider.js';
import {PermanentSendError, ProviderAuthError, ThrottledSendError, TransientSendError} from './EmailProvider.js';

export interface SmtpConnectionConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromOverride?: string | null;
  maxSendRatePerSecond: number;
}

const CAPABILITIES: EmailProviderCapabilities = {
  requiresDomainVerification: false,
  supportsDynamicQuota: false,
  injectsNativeTracking: true,
  supportsDeliveryConfirmation: false,
};

interface NodemailerLikeError extends Error {
  code?: string;
  responseCode?: number;
  rejectedErrors?: {responseCode?: number}[];
}

/**
 * Sends outbound mail through a project-supplied SMTP relay via nodemailer. A
 * fresh transport is constructed per send from decrypted per-project config —
 * no connection pooling in v1 (simplest correct thing; revisit only if send
 * latency profiling shows per-connection overhead actually matters).
 */
export class SmtpProvider implements EmailProvider {
  public readonly type = 'SMTP' as const;
  public readonly capabilities = CAPABILITIES;

  constructor(private readonly config: SmtpConnectionConfig) {}

  public async send(message: OutboundEmailMessage): Promise<{messageId: string}> {
    const transporter = this.createTransport();

    try {
      const info = await transporter.sendMail({
        from: {name: message.from.name, address: this.config.fromOverride || message.from.email},
        to: SmtpProvider.toNodemailerAddresses(message.to),
        replyTo: message.reply,
        subject: message.content.subject,
        html: message.content.html,
        headers: message.headers ?? undefined,
        attachments: message.attachments?.map(attachment => ({
          filename: attachment.filename,
          content: Buffer.from(attachment.content, 'base64'),
          contentType: attachment.contentType,
          cid: attachment.contentId,
          contentDisposition: attachment.disposition ?? 'attachment',
        })),
      });

      return {messageId: info.messageId};
    } catch (error) {
      throw SmtpProvider.classify(error);
    } finally {
      transporter.close();
    }
  }

  public async getThroughput(): Promise<{maxPerSecond: number}> {
    // No dynamic quota API for generic SMTP — static per-project (or default) config.
    return {maxPerSecond: this.config.maxSendRatePerSecond};
  }

  /** Auth/connectivity check with no email actually sent — used by the "Test Connection" endpoint. */
  public async verifyConnection(): Promise<void> {
    const transporter = this.createTransport();
    try {
      await transporter.verify();
    } catch (error) {
      throw SmtpProvider.classify(error);
    } finally {
      transporter.close();
    }
  }

  private createTransport() {
    return nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: {user: this.config.username, pass: this.config.password},
      // Bound how long a hung/unreachable relay can stall a job (or the
      // synchronous "Test Connection" request) — never wait indefinitely.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    });
  }

  private static toNodemailerAddresses(to: OutboundEmailMessage['to']) {
    return to.map(recipient =>
      typeof recipient === 'string'
        ? recipient
        : recipient.name
          ? {name: recipient.name, address: recipient.email}
          : recipient.email,
    );
  }

  private static classify(error: unknown): Error {
    if (!(error instanceof Error)) {
      return new TransientSendError('Unknown SMTP error', error);
    }

    const err = error as NodemailerLikeError;

    // A rejected-recipient response code (from this send, or from the transport's
    // own recipient-level rejection list) is the only synchronous bounce signal
    // generic SMTP gives us.
    const responseCode = err.responseCode ?? err.rejectedErrors?.[0]?.responseCode;
    if (responseCode !== undefined) {
      if (responseCode >= 500) {
        return new PermanentSendError(err.message, err);
      }
      if (responseCode === 421) {
        return new ThrottledSendError(err.message, err);
      }
      if (responseCode >= 400) {
        // Soft rejection (e.g. greylisting) — treated as transient, not a bounce,
        // since generic SMTP gives no reliable way to distinguish the two.
        return new TransientSendError(err.message, err);
      }
    }

    if (err.code === 'EAUTH') {
      return new ProviderAuthError(err.message, err);
    }

    if (err.code === 'ECONNECTION' || err.code === 'ETIMEDOUT' || err.code === 'ESOCKET' || err.code === 'EDNS') {
      return new TransientSendError(err.message, err);
    }

    return new TransientSendError(err.message, err);
  }
}
