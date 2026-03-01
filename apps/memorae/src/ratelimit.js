// ─── In-Memory Rate Limiter ─────────────────────────────────
// No external dependencies. Tracks request counts per key with sliding windows.

class RateLimiter {
  constructor() {
    this.windows = new Map(); // key → [{timestamp, count}]
    // Cleanup every 5 minutes
    setInterval(() => this._cleanup(), 5 * 60 * 1000);
  }

  _getKey(prefix, id) {
    return `${prefix}:${id}`;
  }

  _cleanup() {
    const now = Date.now();
    for (const [key, entries] of this.windows) {
      const filtered = entries.filter(e => now - e.ts < 3600000); // keep last hour
      if (filtered.length === 0) this.windows.delete(key);
      else this.windows.set(key, filtered);
    }
  }

  /**
   * Check if request is allowed
   * @param {string} key - unique identifier
   * @param {number} maxRequests - max requests in window
   * @param {number} windowMs - window in milliseconds
   * @returns {{ allowed: boolean, remaining: number, retryAfter: number }}
   */
  check(key, maxRequests, windowMs) {
    const now = Date.now();
    let entries = this.windows.get(key) || [];
    
    // Remove entries outside window
    entries = entries.filter(e => now - e.ts < windowMs);
    
    const count = entries.reduce((sum, e) => sum + e.count, 0);
    
    if (count >= maxRequests) {
      // Find when the oldest entry in window expires
      const oldest = entries[0];
      const retryAfter = oldest ? Math.ceil((oldest.ts + windowMs - now) / 1000) : 1;
      this.windows.set(key, entries);
      return { allowed: false, remaining: 0, retryAfter };
    }

    entries.push({ ts: now, count: 1 });
    this.windows.set(key, entries);
    return { allowed: true, remaining: maxRequests - count - 1, retryAfter: 0 };
  }
}

const limiter = new RateLimiter();

/**
 * Create rate limiting middleware
 * @param {object} opts
 * @param {number} opts.maxRequests - max requests per window
 * @param {number} opts.windowMs - window in ms (default 60000 = 1 min)
 * @param {string} opts.keyPrefix - prefix for the key
 * @param {function} [opts.keyFn] - custom key extractor (req) => string. Defaults to IP.
 */
function rateLimit({ maxRequests, windowMs = 60000, keyPrefix = 'ip', keyFn } = {}) {
  return (req, res, next) => {
    const id = keyFn ? keyFn(req) : (req.ip || req.connection.remoteAddress || 'unknown');
    const key = `${keyPrefix}:${id}`;
    const result = limiter.check(key, maxRequests, windowMs);

    res.set('X-RateLimit-Limit', String(maxRequests));
    res.set('X-RateLimit-Remaining', String(result.remaining));

    if (!result.allowed) {
      res.set('Retry-After', String(result.retryAfter));
      return res.status(429).json({
        error: 'Too many requests. Please try again later.',
        retryAfter: result.retryAfter
      });
    }

    next();
  };
}

// Pre-built middleware
const publicLimiter = rateLimit({ maxRequests: 30, windowMs: 60000, keyPrefix: 'pub' });
const authLimiter = rateLimit({ maxRequests: 10, windowMs: 60000, keyPrefix: 'auth' });
const signupPhoneLimiter = rateLimit({
  maxRequests: 5,
  windowMs: 3600000, // 1 hour
  keyPrefix: 'signup',
  keyFn: (req) => {
    const phone = req.body && req.body.phone ? req.body.phone.replace(/[^\d]/g, '') : 'unknown';
    return phone;
  }
});

module.exports = { rateLimit, publicLimiter, authLimiter, signupPhoneLimiter, limiter };
