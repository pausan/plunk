import type {EmailProviderCapabilities, OutboundEmailMessage} from '@plunk/types';
import signale from 'signale';

import {redis} from '../../database/redis.js';
import {Keys} from '../keys.js';
import {getSendingQuota, sendRawEmail} from '../SESService.js';
import type {EmailProvider} from './EmailProvider.js';
import {PermanentSendError, ProviderAuthError, ThrottledSendError, TransientSendError} from './EmailProvider.js';

const SES_QUOTA_CACHE_SECONDS = 300; // avoid hammering ses.getSendQuota() on every job
const SES_QUOTA_FALLBACK_MAX_PER_SECOND = 14; // AWS SES sandbox default

const PERMANENT_ERROR_NAMES = new Set(['MessageRejected', 'InvalidParameterValue', 'MailFromDomainNotVerifiedException']);
const AUTH_ERROR_NAMES = new Set([
  'AccessDenied',
  'AccessDeniedException',
  'InvalidClientTokenId',
  'UnrecognizedClientException',
  'SignatureDoesNotMatch',
  'CredentialsProviderError',
]);
const THROTTLED_ERROR_NAMES = new Set(['Throttling', 'ThrottlingException', 'TooManyRequestsException']);

const CAPABILITIES: EmailProviderCapabilities = {
  requiresDomainVerification: true,
  supportsDynamicQuota: true,
  injectsNativeTracking: false,
  supportsDeliveryConfirmation: true,
};

/**
 * Wraps the existing, unmodified SESService.sendRawEmail — SES keeps its exact
 * current hand-rolled raw-MIME implementation. This adapter only adds error
 * classification so the worker can treat SES and SMTP failures uniformly.
 */
class SesProviderImpl implements EmailProvider {
  public readonly type = 'SES' as const;
  public readonly capabilities = CAPABILITIES;

  public async send(message: OutboundEmailMessage): Promise<{messageId: string}> {
    try {
      return await sendRawEmail({
        from: message.from,
        to: message.to,
        content: message.content,
        reply: message.reply,
        headers: message.headers,
        attachments: message.attachments,
        tracking: message.tracking,
      });
    } catch (error) {
      throw SesProviderImpl.classify(error);
    }
  }

  public async getThroughput(): Promise<{maxPerSecond: number}> {
    const quota = await redis
      .get(Keys.EmailProvider.sesQuota())
      .then(cached => (cached ? (JSON.parse(cached) as {maxSendRate: number}) : null));

    if (quota) {
      return {maxPerSecond: quota.maxSendRate};
    }

    const fresh = await getSendingQuota();
    const maxPerSecond = fresh?.maxSendRate ?? SES_QUOTA_FALLBACK_MAX_PER_SECOND;

    if (fresh) {
      await redis.set(
        Keys.EmailProvider.sesQuota(),
        JSON.stringify({maxSendRate: fresh.maxSendRate}),
        'EX',
        SES_QUOTA_CACHE_SECONDS,
      );
    }

    return {maxPerSecond};
  }

  private static classify(error: unknown): Error {
    const name = error instanceof Error ? error.name : undefined;

    if (name && PERMANENT_ERROR_NAMES.has(name)) {
      return new PermanentSendError(error instanceof Error ? error.message : 'Message rejected by AWS SES', error);
    }
    if (name && AUTH_ERROR_NAMES.has(name)) {
      return new ProviderAuthError(error instanceof Error ? error.message : 'AWS SES credentials rejected', error);
    }
    if (name && THROTTLED_ERROR_NAMES.has(name)) {
      return new ThrottledSendError(error instanceof Error ? error.message : 'AWS SES is throttling this account', error);
    }

    signale.warn('[SesProvider] Unclassified SES error, treating as transient:', error);
    return new TransientSendError(error instanceof Error ? error.message : 'Unknown AWS SES error', error);
  }
}

export const SesProvider = new SesProviderImpl();
