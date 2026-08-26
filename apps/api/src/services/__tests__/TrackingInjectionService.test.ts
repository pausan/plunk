import {describe, expect, it} from 'vitest';

import {DASHBOARD_URI} from '../../app/constants';
import {TrackingInjectionService} from '../TrackingInjectionService';

describe('TrackingInjectionService', () => {
  describe('sign/verify', () => {
    it('verifies a signature it produced itself', () => {
      const sig = TrackingInjectionService.sign('email-1', 'open');
      expect(TrackingInjectionService.verify('email-1', 'open', sig)).toBe(true);
    });

    it('rejects a signature for a different emailId (prevents cross-email replay)', () => {
      const sig = TrackingInjectionService.sign('email-1', 'open');
      expect(TrackingInjectionService.verify('email-2', 'open', sig)).toBe(false);
    });

    it('rejects a signature for a different purpose', () => {
      const sig = TrackingInjectionService.sign('email-1', 'open');
      expect(TrackingInjectionService.verify('email-1', 'click', sig)).toBe(false);
    });

    it('rejects a click signature replayed against a different destination URL — this is the open-redirect guard', () => {
      const u = Buffer.from('https://example.com/original-link').toString('base64url');
      const sig = TrackingInjectionService.sign('email-1', 'click', u);

      const attackerUrl = Buffer.from('https://evil.example/phish').toString('base64url');
      expect(TrackingInjectionService.verify('email-1', 'click', sig, attackerUrl)).toBe(false);
    });

    it('rejects an empty/missing signature', () => {
      expect(TrackingInjectionService.verify('email-1', 'open', '')).toBe(false);
    });
  });

  describe('inject', () => {
    const emailId = 'email-123';

    it('appends a signed open-tracking pixel before </body>', () => {
      const html = '<html><body><p>Hello</p></body></html>';
      const result = TrackingInjectionService.inject(html, emailId);

      expect(result).toContain('<p>Hello</p>');
      expect(result.indexOf('<img')).toBeGreaterThan(result.indexOf('<p>Hello</p>'));
      expect(result).toMatch(/<img src="[^"]+\/track\/o\/email-123\.gif\?s=[a-f0-9]+"/);
    });

    it('appends the pixel to the end when there is no </body> tag', () => {
      const html = '<p>No body tag here</p>';
      const result = TrackingInjectionService.inject(html, emailId);
      expect(result.startsWith(html)).toBe(true);
      expect(result).toContain('/track/o/email-123.gif');
    });

    it('rewrites an http(s) link to the click-tracking redirect', () => {
      const html = '<a href="https://example.com/pricing">Pricing</a>';
      const result = TrackingInjectionService.inject(html, emailId);

      expect(result).not.toContain('href="https://example.com/pricing"');
      expect(result).toMatch(/href="[^"]+\/track\/c\/email-123\?u=[A-Za-z0-9_-]+&s=[a-f0-9]+"/);
    });

    it('does not rewrite mailto/tel/anchor links', () => {
      const html = [
        '<a href="mailto:hello@example.com">Email us</a>',
        '<a href="tel:+15551234567">Call</a>',
        '<a href="#section">Jump</a>',
      ].join('');

      const result = TrackingInjectionService.inject(html, emailId);
      expect(result).toContain('href="mailto:hello@example.com"');
      expect(result).toContain('href="tel:+15551234567"');
      expect(result).toContain('href="#section"');
      expect(result).not.toContain('/track/c/');
    });

    it('does not rewrite the unsubscribe/subscribe/manage footer links', () => {
      const html = `<a href="${DASHBOARD_URI}/unsubscribe/contact-1">Unsubscribe</a>`;
      const result = TrackingInjectionService.inject(html, emailId);
      expect(result).toContain(`href="${DASHBOARD_URI}/unsubscribe/contact-1"`);
      expect(result).not.toContain('/track/c/');
    });

    it('round-trips: the rewritten click URL verifies successfully and decodes back to the original destination', () => {
      const original = 'https://example.com/deal?ref=newsletter&id=42';
      const html = `<a href="${original}">Deal</a>`;
      const result = TrackingInjectionService.inject(html, emailId);

      const match = result.match(/href="([^"]+)"/);
      expect(match).not.toBeNull();
      const trackingUrl = new URL(match![1]);
      const u = trackingUrl.searchParams.get('u')!;
      const s = trackingUrl.searchParams.get('s')!;

      expect(TrackingInjectionService.verify(emailId, 'click', s, u)).toBe(true);
      expect(Buffer.from(u, 'base64url').toString('utf8')).toBe(original);
    });
  });
});
