// HTTP security helpers: client-IP extraction, response security headers, and a
// lightweight in-memory rate limiter. Intentionally dependency-free so deploys
// stay a simple `git pull` + restart (no npm install step to break on the Pi).

// Content-Security-Policy. 'unsafe-inline' is required for scripts because the
// app attaches behaviour via generated inline onclick handlers and a few inline
// <script> blocks; the primary XSS defense is output escaping + input validation.
// All JS/CSS (hls.js, Leaflet, GLightbox) is self-hosted under /vendor, so no
// third-party script/style origins are allowed — removes the CDN supply-chain
// path to token theft. img-src still allows https: for OpenStreetMap map tiles.
// The remaining directives (frame-ancestors, object-src, base-uri, form-action)
// still provide real protection (clickjacking, base-tag hijack, form exfil).
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  // hls.js plays the live stream via Media Source Extensions, attaching a
  // blob: URL to the <video> element, and (enableWorker) spawns a blob: worker.
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'"
].join('; ');

// Behind the Cloudflare Tunnel the real visitor IP is in cf-connecting-ip.
// Fall back to x-forwarded-for, then the socket address.
function getClientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return cf;
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
}

// Sliding-window rate limiter keyed on the real client IP. Returns Express
// middleware that responds 429 once an IP exceeds `max` requests per `windowMs`.
function createRateLimiter({ windowMs, max, message = 'Too many requests, please slow down.' }) {
  const hits = new Map(); // ip -> timestamp[]

  // Periodically drop stale IPs so the map can't grow without bound.
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [ip, times] of hits) {
      const fresh = times.filter(t => now - t < windowMs);
      if (fresh.length === 0) hits.delete(ip);
      else hits.set(ip, fresh);
    }
  }, windowMs);
  if (cleanup.unref) cleanup.unref();

  return function rateLimit(req, res, next) {
    const ip = getClientIp(req);
    const now = Date.now();
    const times = (hits.get(ip) || []).filter(t => now - t < windowMs);
    if (times.length >= max) {
      res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: message });
    }
    times.push(now);
    hits.set(ip, times);
    next();
  };
}

module.exports = { getClientIp, securityHeaders, createRateLimiter };
