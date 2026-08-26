import {Controller, Get, Middleware, Patch, Post} from '@overnightjs/core';
import type {SmtpConfig} from '@plunk/db';
import {SendingProviderType} from '@plunk/db';
import {SendingProviderSchemas, UtilitySchemas} from '@plunk/shared';
import type {SendingProviderSettings, SmtpConfigPublic, TestSmtpConnectionResult} from '@plunk/types';
import type {NextFunction, Request, Response} from 'express';

import {prisma} from '../database/prisma.js';
import {BadRequest, HttpException} from '../exceptions/index.js';
import {requireAuth, requireEmailVerified} from '../middleware/auth.js';
import {EncryptionService} from '../services/EncryptionService.js';
import {MembershipService} from '../services/MembershipService.js';
import {SmtpProvider} from '../services/providers/SmtpProvider.js';
import {CatchAsync} from '../utils/asyncHandler.js';

function toPublicSmtpConfig(config: SmtpConfig): SmtpConfigPublic {
  return {
    host: config.host,
    port: config.port,
    secure: config.secure,
    username: config.username,
    fromOverride: config.fromOverride,
    maxSendRatePerSecond: config.maxSendRatePerSecond,
    lastTestedAt: config.lastTestedAt ? config.lastTestedAt.toISOString() : null,
    lastTestOk: config.lastTestOk,
    lastTestError: config.lastTestError,
    configured: true,
  };
}

/**
 * Per-project sending provider settings (AWS SES vs. a custom SMTP relay).
 * Dashboard-only (JWT sessions) — mirrors Projects.ts's `:id` + MembershipService
 * pattern, since this is a project-settings page, not a public API surface.
 * `POST /v1/send` and friends are unaffected: provider selection lives here, not
 * on the send call.
 */
@Controller('sending-provider')
export class SendingProvider {
  /**
   * GET /sending-provider/:id
   */
  @Get(':id')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async get(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id} = UtilitySchemas.id.parse(req.params);

    await MembershipService.requireAccess(auth.userId!, id);

    const project = await prisma.project.findUnique({
      where: {id},
      select: {sendingProvider: true, sendingProviderMisconfigured: true, smtpConfig: true},
    });

    if (!project) {
      throw new HttpException(404, 'Project not found');
    }

    const settings: SendingProviderSettings = {
      sendingProvider: project.sendingProvider,
      sendingProviderMisconfigured: project.sendingProviderMisconfigured,
      smtpConfig: project.smtpConfig ? toPublicSmtpConfig(project.smtpConfig) : null,
    };

    return res.status(200).json(settings);
  }

  /**
   * PATCH /sending-provider/:id
   */
  @Patch(':id')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async update(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id} = UtilitySchemas.id.parse(req.params);
    const body = SendingProviderSchemas.update.parse(req.body);

    await MembershipService.requireAdminAccess(auth.userId!, id);

    const existing = await prisma.smtpConfig.findUnique({where: {projectId: id}});

    if (body.sendingProvider === SendingProviderType.SMTP) {
      if (body.smtpConfig) {
        if (!body.smtpConfig.password && !existing) {
          throw new BadRequest('A password is required the first time SMTP is configured for a project.');
        }

        const passwordFields = body.smtpConfig.password
          ? EncryptionService.encryptPassword(body.smtpConfig.password)
          : null;

        await prisma.smtpConfig.upsert({
          where: {projectId: id},
          create: {
            projectId: id,
            host: body.smtpConfig.host,
            port: body.smtpConfig.port,
            secure: body.smtpConfig.secure,
            username: body.smtpConfig.username,
            fromOverride: body.smtpConfig.fromOverride ?? null,
            maxSendRatePerSecond: body.smtpConfig.maxSendRatePerSecond ?? undefined,
            // password presence is validated above when !existing
            ...passwordFields!,
          },
          update: {
            host: body.smtpConfig.host,
            port: body.smtpConfig.port,
            secure: body.smtpConfig.secure,
            username: body.smtpConfig.username,
            fromOverride: body.smtpConfig.fromOverride ?? null,
            ...(body.smtpConfig.maxSendRatePerSecond !== undefined
              ? {maxSendRatePerSecond: body.smtpConfig.maxSendRatePerSecond}
              : {}),
            // Only touch encrypted fields if a new password was actually submitted
            ...(passwordFields ?? {}),
          },
        });
      } else if (!existing) {
        throw new BadRequest('SMTP has no saved configuration for this project — provide smtpConfig to enable it.');
      }
    }

    const project = await prisma.project.update({
      where: {id},
      data: {
        sendingProvider: body.sendingProvider,
        // A fresh provider selection/config save deserves a clean slate — clear any
        // stale "misconfigured" flag from a previous auth failure.
        sendingProviderMisconfigured: false,
      },
      select: {sendingProvider: true, sendingProviderMisconfigured: true, smtpConfig: true},
    });

    const settings: SendingProviderSettings = {
      sendingProvider: project.sendingProvider,
      sendingProviderMisconfigured: project.sendingProviderMisconfigured,
      smtpConfig: project.smtpConfig ? toPublicSmtpConfig(project.smtpConfig) : null,
    };

    return res.status(200).json(settings);
  }

  /**
   * POST /sending-provider/:id/test
   * Auth/connectivity check only — no email is actually sent, to avoid this
   * endpoint being usable as a spam-relay probe.
   */
  @Post(':id/test')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async test(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id} = UtilitySchemas.id.parse(req.params);
    const body = SendingProviderSchemas.test.parse(req.body);

    await MembershipService.requireAdminAccess(auth.userId!, id);

    const existing = await prisma.smtpConfig.findUnique({where: {projectId: id}});

    if (!body.password && !existing) {
      throw new BadRequest('A password is required to test a connection that has never been saved.');
    }

    const password = body.password ?? (existing ? EncryptionService.decryptPassword(existing) : '');

    const provider = new SmtpProvider({
      host: body.host,
      port: body.port,
      secure: body.secure,
      username: body.username,
      password,
      maxSendRatePerSecond: 1, // irrelevant for a connection check
    });

    let result: TestSmtpConnectionResult;
    try {
      await provider.verifyConnection();
      result = {ok: true};
    } catch (error) {
      result = {ok: false, error: error instanceof Error ? error.message : 'Unknown SMTP connection error'};
    }

    if (existing) {
      await prisma.smtpConfig.update({
        where: {projectId: id},
        data: {lastTestedAt: new Date(), lastTestOk: result.ok, lastTestError: result.error ?? null},
      });
    }

    return res.status(200).json(result);
  }
}
