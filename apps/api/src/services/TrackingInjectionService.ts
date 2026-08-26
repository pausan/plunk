import crypto from 'crypto';

import {API_URI, DASHBOARD_URI, TRACKING_SIGNING_SECRET} from '../app/constants.js';

// Links that must never get an extra tracking-redirect hop.
const EXCLUDED_HREF_PREFIXES = [
  `${DASHBOARD_URI}/unsubscribe/`,
  `${DASHBOARD_URI}/subscribe/`,
  `${DASHBOARD_URI}/manage/`,
];

const HREF_REGEX = /href="(https?:\/\/[^"]+)"/gi;

type TrackingPurpose = 'open' | 'click';

/**
 * Injects Plunk-native open/click tracking into compiled HTML for SMTP-sent mail
 * (see EmailProviderCapabilities.injectsNativeTracking). AWS SES gets this for
 * free via its own configuration-set link-wrapping/pixel — this service is only
 * used on the SMTP path, which has no equivalent.
 *
 * Follows the same plain string-templating style already used by
 * EmailService.compile (no HTML parsing library is used anywhere in this
 * codebase) — a regex link rewrite plus a `</body>`-anchored pixel insert.
 */
export class TrackingInjectionService {
  public static inject(html: string, emailId: string): string {
    if (TRACKING_SIGNING_SECRET === '') {
      // Not configured — degrade to "no tracking" rather than failing every send.
      return html;
    }

    const withRewrittenLinks = html.replace(HREF_REGEX, (match, url: string) => {
      if (EXCLUDED_HREF_PREFIXES.some(prefix => url.startsWith(prefix))) {
        return match;
      }
      return `href="${TrackingInjectionService.clickUrl(emailId, url)}"`;
    });

    const pixel = `<img src="${TrackingInjectionService.openUrl(emailId)}" width="1" height="1" style="display:none" alt="" />`;

    return withRewrittenLinks.includes('</body>')
      ? withRewrittenLinks.replace('</body>', `${pixel}</body>`)
      : `${withRewrittenLinks}${pixel}`;
  }

  public static openUrl(emailId: string): string {
    const sig = TrackingInjectionService.sign(emailId, 'open');
    return `${API_URI}/track/o/${emailId}.gif?s=${sig}`;
  }

  public static clickUrl(emailId: string, destinationUrl: string): string {
    const u = Buffer.from(destinationUrl, 'utf8').toString('base64url');
    const sig = TrackingInjectionService.sign(emailId, 'click', u);
    return `${API_URI}/track/c/${emailId}?u=${u}&s=${sig}`;
  }

  /**
   * Signature is over emailId + purpose + the destination URL (when present) — not
   * just emailId. This is security-critical: signing only emailId would turn the
   * click route into an open redirect (an attacker could point /track/c/:emailId
   * at any URL using Plunk's domain reputation) since `u` isn't otherwise authenticated.
   */
  public static sign(emailId: string, purpose: TrackingPurpose, u = ''): string {
    return crypto
      .createHmac('sha256', TRACKING_SIGNING_SECRET)
      .update(`${emailId}:${purpose}:${u}`)
      .digest('hex')
      .slice(0, 32);
  }

  public static verify(emailId: string, purpose: TrackingPurpose, sig: string, u = ''): boolean {
    if (TRACKING_SIGNING_SECRET === '' || !sig) {
      return false;
    }

    const expected = Buffer.from(TrackingInjectionService.sign(emailId, purpose, u));
    const actual = Buffer.from(sig);

    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }
}
