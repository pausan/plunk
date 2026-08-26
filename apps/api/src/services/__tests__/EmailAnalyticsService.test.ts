import {describe, expect, it} from 'vitest';
import {EmailStatus} from '@plunk/db';
import {factories, getPrismaClient} from '../../../../../test/helpers';
import {EmailAnalyticsService} from '../EmailAnalyticsService';

// This is the shared logic behind both the AWS SES SNS webhook (Webhooks.ts) and
// the native SMTP tracking routes (Tracking.ts) / synchronous bounce handling
// (jobs/email-processor.ts) — these tests pin down the behavior that used to
// live inline in Webhooks.ts's receiveSNSWebhook before the extraction.
describe('EmailAnalyticsService', () => {
  const prisma = getPrismaClient();

  async function setup() {
    const {project} = await factories.createUserWithProject();
    const contact = await factories.createContact({projectId: project.id});
    const created = await factories.createEmail(project.id, contact.id, {status: EmailStatus.SENT});
    const email = await prisma.email.findUniqueOrThrow({
      where: {id: created.id},
      include: {contact: true, project: true},
    });
    return {project, contact, email};
  }

  it('recordDelivery sets status DELIVERED and stamps deliveredAt', async () => {
    const {email} = await setup();
    await EmailAnalyticsService.recordDelivery(email);

    const updated = await prisma.email.findUniqueOrThrow({where: {id: email.id}});
    expect(updated.status).toBe(EmailStatus.DELIVERED);
    expect(updated.deliveredAt).not.toBeNull();
  });

  it('recordOpen sets openedAt only on the first open, but increments the counter every time', async () => {
    const {email} = await setup();

    await EmailAnalyticsService.recordOpen(email);
    const afterFirst = await prisma.email.findUniqueOrThrow({where: {id: email.id}});
    expect(afterFirst.status).toBe(EmailStatus.OPENED);
    expect(afterFirst.opens).toBe(1);
    expect(afterFirst.openedAt).not.toBeNull();

    await EmailAnalyticsService.recordOpen({...afterFirst, contact: email.contact, project: email.project});
    const afterSecond = await prisma.email.findUniqueOrThrow({where: {id: email.id}});
    expect(afterSecond.opens).toBe(2);
    expect(afterSecond.openedAt?.getTime()).toBe(afterFirst.openedAt?.getTime());
  });

  it('recordClick sets clickedAt only on the first click, but increments the counter every time', async () => {
    const {email} = await setup();

    await EmailAnalyticsService.recordClick(email, 'https://example.com/a');
    const afterFirst = await prisma.email.findUniqueOrThrow({where: {id: email.id}});
    expect(afterFirst.status).toBe(EmailStatus.CLICKED);
    expect(afterFirst.clicks).toBe(1);
    expect(afterFirst.clickedAt).not.toBeNull();

    await EmailAnalyticsService.recordClick(
      {...afterFirst, contact: email.contact, project: email.project},
      'https://example.com/b',
    );
    const afterSecond = await prisma.email.findUniqueOrThrow({where: {id: email.id}});
    expect(afterSecond.clicks).toBe(2);
    expect(afterSecond.clickedAt?.getTime()).toBe(afterFirst.clickedAt?.getTime());
  });

  it('recordBounce(Permanent) marks the email BOUNCED and unsubscribes the contact', async () => {
    const {email, contact} = await setup();
    await EmailAnalyticsService.recordBounce(email, {bounceType: 'Permanent', synchronous: true, reason: 'SMTP 550'});

    const updatedEmail = await prisma.email.findUniqueOrThrow({where: {id: email.id}});
    const updatedContact = await prisma.contact.findUniqueOrThrow({where: {id: contact.id}});
    expect(updatedEmail.status).toBe(EmailStatus.BOUNCED);
    expect(updatedEmail.bouncedAt).not.toBeNull();
    expect(updatedContact.subscribed).toBe(false);
  });

  it('recordBounce(Transient) does not change status or unsubscribe the contact — not counted toward bounce rate', async () => {
    const {email, contact} = await setup();
    await EmailAnalyticsService.recordBounce(email, {bounceType: 'Transient'});

    const updatedEmail = await prisma.email.findUniqueOrThrow({where: {id: email.id}});
    const updatedContact = await prisma.contact.findUniqueOrThrow({where: {id: contact.id}});
    expect(updatedEmail.status).toBe(EmailStatus.SENT); // unchanged
    expect(updatedEmail.bouncedAt).toBeNull();
    expect(updatedContact.subscribed).toBe(true);
  });

  it('recordComplaint marks the email COMPLAINED and unsubscribes the contact', async () => {
    const {email, contact} = await setup();
    await EmailAnalyticsService.recordComplaint(email);

    const updatedEmail = await prisma.email.findUniqueOrThrow({where: {id: email.id}});
    const updatedContact = await prisma.contact.findUniqueOrThrow({where: {id: contact.id}});
    expect(updatedEmail.status).toBe(EmailStatus.COMPLAINED);
    expect(updatedEmail.complainedAt).not.toBeNull();
    expect(updatedContact.subscribed).toBe(false);
  });
});
