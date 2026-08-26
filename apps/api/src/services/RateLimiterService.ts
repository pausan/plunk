import {redis} from '../database/redis.js';
import {Keys} from './keys.js';

/**
 * Simple fixed-window rate limiter backed by Redis. Used to throttle per-project
 * SMTP throughput independently of the shared BullMQ worker's global concurrency/
 * limiter (email-processor.ts's `limiter` option, which stays a coarse safety
 * ceiling, not a per-provider one). SES sends skip this check entirely — SES
 * throughput/behavior is unchanged from today.
 *
 * Fixed-window (INCR+EXPIRE on a per-second bucket), not a true token bucket, is
 * a deliberate v1 simplification: it allows brief burstiness at window edges,
 * which is an acceptable trade-off for the precision this needs.
 */
export class RateLimiterService {
  /** Returns true if a slot was available and consumed; false if the caller should back off. */
  public static async tryConsume(bucketKey: string, maxPerSecond: number): Promise<boolean> {
    const windowSeconds = Math.floor(Date.now() / 1000);
    const key = Keys.EmailProvider.rateLimitWindow(bucketKey, windowSeconds);

    const count = await redis.incr(key);
    if (count === 1) {
      // First increment in this window — set expiry so the key cleans itself up.
      // A little slack over 1s covers clock/latency jitter around window edges.
      await redis.expire(key, 2);
    }

    return count <= maxPerSecond;
  }
}
