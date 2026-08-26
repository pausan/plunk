import {Controller, Get} from '@overnightjs/core';
import type {Request, Response} from 'express';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {EmailAnalyticsService} from '../services/EmailAnalyticsService.js';
import {TrackingInjectionService} from '../services/TrackingInjectionService.js';
import {CatchAsync} from '../utils/asyncHandler.js';

// A minimal, valid 1x1 transparent GIF — served for every open-pixel request
// regardless of whether the signature validated, so a bad/expired token never
// shows up as a broken image to the recipient.
const TRANSPARENT_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

function parseHttpUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Native open/click tracking for SMTP-sent mail (see TrackingInjectionService,
 * which embeds these URLs in the compiled HTML). Unauthenticated by design —
 * these routes are hit directly by mail clients/browsers, not by Plunk users.
 *
 * Both routes fail open: a bad/expired/missing signature never breaks the pixel
 * or the recipient's click, it just skips the analytics write.
 */
@Controller('track')
export class Tracking {
  /**
   * GET /track/o/:emailId.gif?s=<sig>
   */
  @Get('o/:emailId.gif')
  @CatchAsync
  public async open(req: Request, res: Response) {
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'image/gif');

    const {emailId} = req.params;
    const sig = typeof req.query.s === 'string' ? req.query.s : '';

    if (emailId && TrackingInjectionService.verify(emailId, 'open', sig)) {
      // Fire-and-forget — never block the pixel response on the DB write.
      Tracking.recordOpen(emailId).catch(error => signale.warn('[TRACKING] Failed to record open:', error));
    }

    return res.status(200).send(TRANSPARENT_GIF);
  }

  /**
   * GET /track/c/:emailId?u=<base64url(destUrl)>&s=<sig>
   */
  @Get('c/:emailId')
  @CatchAsync
  public async click(req: Request, res: Response) {
    const {emailId} = req.params;
    const encodedUrl = typeof req.query.u === 'string' ? req.query.u : '';
    const sig = typeof req.query.s === 'string' ? req.query.s : '';

    let destinationUrl: string | null = null;
    try {
      destinationUrl = parseHttpUrl(Buffer.from(encodedUrl, 'base64url').toString('utf8'));
    } catch {
      destinationUrl = null;
    }

    if (!destinationUrl) {
      return res.status(400).send('Invalid tracking link');
    }

    if (emailId && TrackingInjectionService.verify(emailId, 'click', sig, encodedUrl)) {
      try {
        await Tracking.recordClick(emailId, destinationUrl);
      } catch (error) {
        signale.warn('[TRACKING] Failed to record click:', error);
      }
    } else {
      signale.warn(`[TRACKING] Rejected click tracking request for email ${emailId} — invalid or missing signature`);
    }

    // Fail open — redirect regardless of whether tracking succeeded/validated.
    return res.redirect(302, destinationUrl);
  }

  private static async recordOpen(emailId: string): Promise<void> {
    const email = await prisma.email.findUnique({where: {id: emailId}, include: {contact: true, project: true}});
    if (!email) return;
    await EmailAnalyticsService.recordOpen(email, {synchronous: true});
  }

  private static async recordClick(emailId: string, link: string): Promise<void> {
    const email = await prisma.email.findUnique({where: {id: emailId}, include: {contact: true, project: true}});
    if (!email) return;
    await EmailAnalyticsService.recordClick(email, link, {synchronous: true});
  }
}
