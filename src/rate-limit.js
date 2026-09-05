'use strict';

/**
 * A sliding-window counter, per caller identity and across all callers. In
 * process, because the bridge is one process on one machine; if it is ever run
 * more than once on the same host the limit becomes per process and the README
 * has to say so.
 */
class RateLimiter {
  constructor(perMinute, now) {
    this.limit = perMinute;
    this.windowMs = 60000;
    this.now = now || (() => Date.now());
    this.hits = new Map();
  }

  /** @returns {{allowed: boolean, retryAfterSeconds: number, remaining: number}} */
  take(key) {
    const t = this.now();
    const cutoff = t - this.windowMs;
    const times = (this.hits.get(key) || []).filter((x) => x > cutoff);
    if (times.length >= this.limit) {
      const retryAfterMs = times[0] + this.windowMs - t;
      this.hits.set(key, times);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
        remaining: 0
      };
    }
    times.push(t);
    this.hits.set(key, times);
    if (this.hits.size > 1000) this.sweep(cutoff);
    return { allowed: true, retryAfterSeconds: 0, remaining: this.limit - times.length };
  }

  sweep(cutoff) {
    for (const [key, times] of this.hits) {
      const kept = times.filter((x) => x > cutoff);
      if (kept.length === 0) this.hits.delete(key);
      else this.hits.set(key, kept);
    }
  }
}

module.exports = { RateLimiter };
