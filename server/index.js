require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const cookieParser = require('cookie-parser');
const { WebSocketServer } = require('ws');
const config = require('../config.json');
const { initDb, getSession, hasPtzAccess, hasPtzDriving, isUserApproved, getActivityLog, flushDataSync } = require('./db');
const { setupChat } = require('./chat');
const apiRoutes = require('./routes/api');
const { initMailer } = require('./mailer');
const { securityHeaders, createRateLimiter } = require('./security');
const { backfillFromActivityLog } = require('./visited-locations');
const { startInfraAlertPoller } = require('./infra-alerts');

const PRIVACY_FLAG = path.join(__dirname, '../.privacy-mode');
const HIDDEN_CAMS_DIR = path.join(__dirname, '../.hidden-cams');

function isPrivacyMode() {
  return fs.existsSync(PRIVACY_FLAG);
}

function isCameraHidden(camId) {
  return fs.existsSync(path.join(HIDDEN_CAMS_DIR, camId));
}

function setCameraHidden(camId, hidden) {
  if (!fs.existsSync(HIDDEN_CAMS_DIR)) {
    fs.mkdirSync(HIDDEN_CAMS_DIR, { recursive: true });
  }
  const flagPath = path.join(HIDDEN_CAMS_DIR, camId);
  if (hidden) {
    fs.writeFileSync(flagPath, Date.now().toString());
  } else if (fs.existsSync(flagPath)) {
    fs.unlinkSync(flagPath);
  }
}

const app = express();
const server = http.createServer(app);

// Running behind the Cloudflare Tunnel — cloudflared connects from loopback, so
// trust ONLY the loopback hop for X-Forwarded-* (req.ip / req.secure). Trusting
// every upstream would let a direct LAN client to :3000 spoof X-Forwarded-For
// (poisoning rate-limit/geo) or X-Forwarded-Proto (downgrading the cookie).
app.set('trust proxy', 'loopback');

// Expected production host, from SITE_URL — used to validate the Origin on
// cookie-authenticated mutations and chat WebSocket handshakes without depending
// on the tunnel preserving the inbound Host header.
let SITE_HOST = null;
try { SITE_HOST = process.env.SITE_URL ? new URL(process.env.SITE_URL).host : null; } catch (e) { /* ignore */ }
function isAllowedOriginHost(originHost, reqHost) {
  if (!originHost) return false;
  return originHost === reqHost || (SITE_HOST && originHost === SITE_HOST);
}

initDb();
initMailer();

// Best-effort one-time seed of the permanent visitor map from the existing
// activity log, so it isn't empty on first deploy. No-op if already seeded.
try {
  backfillFromActivityLog(getActivityLog());
} catch (err) {
  console.error('Visitor map backfill failed:', err.message);
}

app.use(securityHeaders);
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());

// CSRF defense for cookie-authenticated state changes. The session cookie is
// SameSite=Lax (so cross-site POST/DELETE don't even send it) — this is the
// belt-and-suspenders second layer: any cookie-authenticated mutating request
// must carry an Origin header whose host matches ours. Requests authenticated by
// header/query token (no cookie) are not ambient-auth and are exempt, as are
// safe methods and token-in-URL flows (login, password reset) that carry no cookie.
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
app.use((req, res, next) => {
  if (!STATE_CHANGING_METHODS.has(req.method)) return next();
  if (!(req.cookies && req.cookies.sf_session)) return next();
  const origin = req.headers.origin;
  if (!origin) return res.status(403).json({ error: 'Missing Origin header' });
  let originHost;
  try { originHost = new URL(origin).host; } catch (e) {
    return res.status(403).json({ error: 'Invalid Origin header' });
  }
  if (!isAllowedOriginHost(originHost, req.headers.host)) {
    return res.status(403).json({ error: 'Cross-origin request blocked' });
  }
  next();
});

// Throttle auth + write-heavy endpoints to stop brute force / abuse.
const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 40,
  message: 'Too many attempts, please try again later.'
});
app.use(['/api/login', '/api/register', '/api/forgot-password', '/api/reset-password'], authLimiter);

app.use('/api', apiRoutes);

app.get('/api/admin/privacy-mode', (req, res) => {
  const session = sessionFromRequest(req);
  if (!session || !session.isAdmin) return res.status(403).json({ error: 'Admin required' });
  res.json({ enabled: isPrivacyMode() });
});

app.post('/api/admin/privacy-mode', (req, res) => {
  const session = sessionFromRequest(req);
  if (!session || !session.isAdmin) return res.status(403).json({ error: 'Admin required' });

  if (isPrivacyMode()) {
    fs.unlinkSync(PRIVACY_FLAG);
    res.json({ enabled: false });
  } else {
    fs.writeFileSync(PRIVACY_FLAG, Date.now().toString());
    res.json({ enabled: true });
  }
});

// Camera streams and all saved footage are private: every media byte requires a
// valid, approved session. The browser sends the httpOnly `sf_session` cookie
// automatically on <video>/<img>/fetch, so this gate covers content that can't
// carry the x-auth-token header. The header is also accepted (API clients).
const PROTECTED_MEDIA_PREFIXES = [
  '/hls', '/hls2', '/hls3',
  '/favorites', '/highlights', '/motion-timelapse', '/chick-growth',
  '/motion-captures' // predator/motion snapshots from motion-detect.sh
];

function sessionFromRequest(req) {
  // Cookie is the browser credential; x-auth-token header is the API-client
  // fallback (cross-site JS can't set it without a CORS preflight we never grant).
  // No ?token= query fallback — a session token in a URL is CSRF-exempt and leaks
  // into logs/history.
  const token = (req.cookies && req.cookies.sf_session) || req.headers['x-auth-token'];
  return token ? getSession(token) : null;
}

// Normalize a request path the SAME way express.static/send will resolve it, so
// the prefix check can't be slipped with //hls, /hls%2ffile (encoded slash),
// /foo/../hls, backslashes, or mixed case. Match on this, never the raw req.path.
function normalizeForGate(rawPath) {
  let p = rawPath || '/';
  try { p = decodeURIComponent(p); } catch (e) { /* malformed %-escape: match on raw */ }
  p = p.replace(/\\/g, '/');           // backslash → slash (Windows-style separators)
  p = path.posix.normalize(p);         // resolves '.', '..', collapses '//'
  if (!p.startsWith('/')) p = '/' + p; // normalize() can drop the leading slash
  return p.toLowerCase();
}

app.use((req, res, next) => {
  const p = normalizeForGate(req.path);
  const isProtected = PROTECTED_MEDIA_PREFIXES.some(
    prefix => p === prefix || p.startsWith(prefix + '/')
  );
  if (!isProtected) return next();

  // Privacy mode blacks out the LIVE streams for everyone (looks like signal loss).
  if (isPrivacyMode() && p.startsWith('/hls')) return res.status(404).end();

  const session = sessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (config.requireApproval && !isUserApproved(session.username)) {
    return res.status(403).json({ error: 'Account not approved' });
  }
  next();
});

app.use(express.static(path.join(__dirname, '../public')));

app.get('/config/cameras', (req, res) => {
  // Require login (and approval when enabled), same policy as the media gate —
  // don't leak camera names / stream paths pre-auth.
  const session = sessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (config.requireApproval && !isUserApproved(session.username)) {
    return res.status(403).json({ error: 'Account not approved' });
  }
  const isAdminUser = session && session.isAdmin;
  const canPtz = session && hasPtzAccess(session.username);
  const canDrive = session && hasPtzDriving(session.username);

  const cameras = config.cameras
    .filter(cam => cam.enabled)
    .filter(cam => {
      const hidden = isCameraHidden(cam.id);
      if (hidden && !isAdminUser) return false;
      return true;
    })
    .map(({ id, name, streamUrl, ptz }) => ({
      id, name, streamUrl,
      hasPtz: canPtz && !!(ptz && ptz.ip),
      hasPtzDriving: canDrive && !!(ptz && ptz.ip),
      ptzCapabilities: canPtz && ptz && ptz.ip ? (ptz.capabilities || ['pan', 'tilt']) : [],
      hidden: isCameraHidden(id)
    }));
  res.json(cameras);
});

app.get('/api/admin/cameras', (req, res) => {
  const session = sessionFromRequest(req);
  if (!session || !session.isAdmin) return res.status(403).json({ error: 'Admin required' });

  const cameras = config.cameras
    .map(({ id, name, enabled }) => ({ id, name, enabled, hidden: isCameraHidden(id) }));
  res.json(cameras);
});

app.post('/api/admin/cameras/:id/toggle', (req, res) => {
  const session = sessionFromRequest(req);
  if (!session || !session.isAdmin) return res.status(403).json({ error: 'Admin required' });

  const cam = config.cameras.find(c => c.id === req.params.id && c.enabled);
  if (!cam) return res.status(404).json({ error: 'Camera not found' });

  const currentlyHidden = isCameraHidden(cam.id);
  setCameraHidden(cam.id, !currentlyHidden);
  res.json({ id: cam.id, hidden: !currentlyHidden });
});

const CONFIG_PATH = path.join(__dirname, '../config.json');

app.post('/api/admin/cameras/:id/enable', (req, res) => {
  const session = sessionFromRequest(req);
  if (!session || !session.isAdmin) return res.status(403).json({ error: 'Admin required' });

  const cam = config.cameras.find(c => c.id === req.params.id);
  if (!cam) return res.status(404).json({ error: 'Camera not found' });

  cam.enabled = !cam.enabled;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  res.json({ id: cam.id, enabled: cam.enabled });
});

const wss = new WebSocketServer({ server, path: '/chat' });
setupChat(wss);

server.listen(config.port, () => {
  console.log(`Chicken Stream running at http://localhost:${config.port}`);
});

// Proactive infra alerting (camera down / disk full / temp critical) over the
// existing email/SMS path — see server/infra-alerts.js.
startInfraAlertPoller();

// data.json writes are coalesced (see db.js); flush any pending write on a
// graceful shutdown so the deploy's `kill` (SIGTERM) / Ctrl-C never drops data.
function gracefulShutdown() {
  try { flushDataSync(); } catch (err) { console.error('Shutdown flush failed:', err.message); }
  process.exit(0);
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
