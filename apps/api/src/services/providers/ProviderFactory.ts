import type {Project, SmtpConfig} from '@plunk/db';
import {SendingProviderType} from '@plunk/db';

import {SMTP_DEFAULT_RATE_LIMIT_PER_SECOND} from '../../app/constants.js';
import {EncryptionService} from '../EncryptionService.js';
import type {EmailProvider} from './EmailProvider.js';
import {ProviderAuthError} from './EmailProvider.js';
import {SesProvider} from './SesProvider.js';
import {SmtpProvider} from './SmtpProvider.js';

export type ProjectWithSmtpConfig = Project & {smtpConfig: SmtpConfig | null};

/**
 * Resolves the EmailProvider to use for a given project. This is the single
 * dispatch point between the SES-backed default and a project's own SMTP relay —
 * see apps/api/src/jobs/email-processor.ts for the (only) production call site.
 */
export class ProviderFactory {
  public static async forProject(project: ProjectWithSmtpConfig): Promise<EmailProvider> {
    if (project.sendingProvider !== SendingProviderType.SMTP) {
      return SesProvider;
    }

    if (!project.smtpConfig) {
      throw new ProviderAuthError(
        `Project ${project.id} has SMTP selected as its sending provider but has no SmtpConfig saved`,
      );
    }

    return new SmtpProvider({
      host: project.smtpConfig.host,
      port: project.smtpConfig.port,
      secure: project.smtpConfig.secure,
      username: project.smtpConfig.username,
      password: EncryptionService.decryptPassword(project.smtpConfig),
      fromOverride: project.smtpConfig.fromOverride,
      maxSendRatePerSecond: project.smtpConfig.maxSendRatePerSecond ?? SMTP_DEFAULT_RATE_LIMIT_PER_SECOND,
    });
  }
}
