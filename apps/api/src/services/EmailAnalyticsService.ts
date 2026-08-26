import type {Contact, Email, Project} from '@plunk/db';
import {EmailStatus} from '@plunk/db';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {EventService} from './EventService.js';
import {NtfyService} from './NtfyService.js';
import {SecurityService} from './SecurityService.js';

export type EmailWithRelations = Email & {contact: Contact; project: Project};

interface EventMeta {
  /** Distinguishes a synchronous SMTP-detected event from an async SES/SNS one.
   * Omitted (not just false) by the SES webhook path, which never sent this field
   * before this service existed — keeps that path's event payloads byte-identical. */
  synchronous?: boolean;
}

interface BounceMeta extends EventMeta {
  bounceType: 'Permanent' | 'Transient';
  /** Raw bounce-type text for the notification/event payload. SES sometimes reports
   * types outside 'Permanent'/'Transient' — callers must map those to 'Permanent'
   * before calling this (matching prior behavior: unknown types are treated as
   * permanent) but may pass the original string here for observability/notifications. */
  rawType?: string;
  /** SMTP-only: the rejection message from the relay. */
  reason?: string;
}

/**
 * Owns "what happens when an email is opened/clicked/delivered/bounces/complains" —
 * the single, provider-agnostic implementation shared by the AWS SES SNS webhook
 * (Webhooks.ts) and the native SMTP tracking routes (Tracking.ts) + synchronous
 * SMTP bounce detection (jobs/email-processor.ts). Extracted verbatim from the
 * logic that used to live inline in Webhooks.ts's receiveSNSWebhook — behavior for
 * the SES path is unchanged by this extraction.
 */
export class EmailAnalyticsService {
  public static async recordDelivery(email: EmailWithRelations, meta: EventMeta = {}): Promise<void> {
    const now = new Date();

    await prisma.email.update({
      where: {id: email.id},
      data: {status: EmailStatus.DELIVERED, deliveredAt: now},
    });

    await EventService.trackEvent(email.projectId, 'email.delivery', email.contactId, email.id, {
      ...EmailAnalyticsService.baseEventData(email),
      deliveredAt: now.toISOString(),
      ...EmailAnalyticsService.metaFields(meta),
    });

    signale.success(`[EMAIL-ANALYTICS] Delivery confirmed for ${email.contact.email} from ${email.project.name}`);
  }

  public static async recordOpen(email: EmailWithRelations, meta: EventMeta = {}): Promise<void> {
    const now = new Date();
    const isFirstOpen = !email.openedAt;
    const opens = (email.opens || 0) + 1;

    await prisma.email.update({
      where: {id: email.id},
      data: {
        ...(isFirstOpen ? {openedAt: now} : {}),
        opens,
        status: EmailStatus.OPENED,
      },
    });

    await EventService.trackEvent(email.projectId, 'email.open', email.contactId, email.id, {
      ...EmailAnalyticsService.baseEventData(email),
      openedAt: (email.openedAt ?? now).toISOString(),
      opens,
      isFirstOpen,
      ...EmailAnalyticsService.metaFields(meta),
    });

    signale.success(`[EMAIL-ANALYTICS] Open received for ${email.contact.email} from ${email.project.name}`);
  }

  public static async recordClick(email: EmailWithRelations, link: string, meta: EventMeta = {}): Promise<void> {
    const now = new Date();
    const isFirstClick = !email.clickedAt;
    const clicks = (email.clicks || 0) + 1;

    await prisma.email.update({
      where: {id: email.id},
      data: {
        ...(isFirstClick ? {clickedAt: now} : {}),
        clicks,
        status: EmailStatus.CLICKED,
      },
    });

    await EventService.trackEvent(email.projectId, 'email.click', email.contactId, email.id, {
      ...EmailAnalyticsService.baseEventData(email),
      link,
      clickedAt: (email.clickedAt ?? now).toISOString(),
      clicks,
      isFirstClick,
      ...EmailAnalyticsService.metaFields(meta),
    });

    signale.success(`[EMAIL-ANALYTICS] Click received for ${email.contact.email} from ${email.project.name}`);
  }

  public static async recordBounce(email: EmailWithRelations, meta: BounceMeta): Promise<void> {
    const now = new Date();
    const rawType = meta.rawType ?? meta.bounceType;

    if (meta.bounceType === 'Transient') {
      // Soft bounce (e.g. out-of-office, mailbox full) — doesn't count toward bounce
      // rate, doesn't unsubscribe the contact. Just tracked for visibility.
      signale.info(
        `[EMAIL-ANALYTICS] Transient bounce for ${email.contact.email} from ${email.project.name} (not counted toward bounce rate)`,
      );

      await EventService.trackEvent(email.projectId, 'email.bounce', email.contactId, email.id, {
        ...EmailAnalyticsService.baseEventData(email),
        bounceType: rawType,
        transientBounce: true,
        ...EmailAnalyticsService.metaFields(meta),
      });
      return;
    }

    // Permanent (or unknown-and-treated-as-permanent, per the caller's mapping) —
    // counts toward bounce rate and unsubscribes the contact.
    signale.warn(`[EMAIL-ANALYTICS] Permanent bounce for ${email.contact.email} from ${email.project.name}`);

    await prisma.email.update({
      where: {id: email.id},
      data: {status: EmailStatus.BOUNCED, bouncedAt: now},
    });

    await prisma.contact.update({
      where: {id: email.contactId},
      data: {subscribed: false},
    });

    await EventService.trackEvent(email.projectId, 'email.bounce', email.contactId, email.id, {
      ...EmailAnalyticsService.baseEventData(email),
      bounceType: rawType,
      bouncedAt: now.toISOString(),
      ...EmailAnalyticsService.metaFields(meta),
    });

    await NtfyService.notifyEmailBounce(email.project.name, email.projectId, email.contact.email, rawType);

    await SecurityService.checkAndEnforceSecurityLimits(email.projectId);
  }

  public static async recordComplaint(email: EmailWithRelations, meta: EventMeta = {}): Promise<void> {
    const now = new Date();

    signale.warn(`[EMAIL-ANALYTICS] Complaint received for ${email.contact.email} from ${email.project.name}`);

    await prisma.email.update({
      where: {id: email.id},
      data: {status: EmailStatus.COMPLAINED, complainedAt: now},
    });

    await prisma.contact.update({
      where: {id: email.contactId},
      data: {subscribed: false},
    });

    await EventService.trackEvent(email.projectId, 'email.complaint', email.contactId, email.id, {
      ...EmailAnalyticsService.baseEventData(email),
      complainedAt: now.toISOString(),
      ...EmailAnalyticsService.metaFields(meta),
    });

    await NtfyService.notifyEmailComplaint(email.project.name, email.projectId, email.contact.email);

    await SecurityService.checkAndEnforceSecurityLimits(email.projectId);
  }

  private static baseEventData(email: EmailWithRelations) {
    return {
      subject: email.subject,
      from: email.from,
      fromName: email.fromName,
      messageId: email.messageId,
      emailId: email.id,
      templateId: email.templateId,
      campaignId: email.campaignId,
      sourceType: email.sourceType,
    };
  }

  /** Only include optional meta fields in the event payload when the caller actually
   * provided them — keeps the SES webhook path's payloads byte-identical to before. */
  private static metaFields(meta: EventMeta | BounceMeta): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    if (meta.synchronous !== undefined) fields.synchronous = meta.synchronous;
    if ('reason' in meta && meta.reason !== undefined) fields.reason = meta.reason;
    return fields;
  }
}
