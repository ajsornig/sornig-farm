require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const cookieParser = require('cookie-parser');
const { WebSocketServer } = require('ws');
const config = require('../config.json');
const { initDb, getSession } = require('./db');
const { setupChat } = require('./chat');
const apiRoutes = require('./routes/api');
const { initMailer } = require('./mailer');
const { securityHeaders, createRateLimiter } = require('./security');

const PRIVACY_FLAG = path.join(__dirname, '../.privacy-mode');

function isPrivacyMode() {
  return fs.existsSync(PRIVACY_FLAG);
}

const app = express();
const server = http.createServer(app);

// Running behind the Cloudflare Tunnel — trust the proxy so req.ip resolves.
app.set('trust proxy', true);

initDb();
initMailer();

app.use(securityHeaders);
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());

// Throttle auth + write-heavy endpoints to stop brute force / abuse.
const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 40,
  message: 'Too many attempts, please try again later.'
});
app.use(['/api/login', '/api/register', '/api/forgot-password', '/api/reset-password'], authLimiter);

const analyticsLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 60 });
app.use('/api/timelapse/analytics', analyticsLimiter);

app.use('/api', apiRoutes);

app.get('/api/admin/privacy-mode', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const session = getSession(token);
  if (!session || !session.isAdmin) return res.status(403).json({ error: 'Admin required' });
  res.json({ enabled: isPrivacyMode() });
});

app.post('/api/admin/privacy-mode', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const session = getSession(token);
  if (!session || !session.isAdmin) return res.status(403).json({ error: 'Admin required' });

  if (isPrivacyMode()) {
    fs.unlinkSync(PRIVACY_FLAG);
    res.json({ enabled: false });
  } else {
    fs.writeFileSync(PRIVACY_FLAG, Date.now().toString());
    res.json({ enabled: true });
  }
});

// Block HLS streams when privacy mode is active (looks like signal loss)
app.use('/hls', (req, res, next) => {
  if (isPrivacyMode()) return res.status(404).end();
  next();
});
app.use('/hls2', (req, res, next) => {
  if (isPrivacyMode()) return res.status(404).end();
  next();
});
app.use('/hls3', (req, res, next) => {
  if (isPrivacyMode()) return res.status(404).end();
  next();
});

app.use(express.static(path.join(__dirname, '../public')));

app.get('/config/cameras', (req, res) => {
  const token = req.headers['x-auth-token'];
  const session = token ? getSession(token) : null;
  const isAdmin = session && session.isAdmin;

  const cameras = config.cameras
    .filter(cam => cam.enabled && (!cam.adminOnly || isAdmin))
    .map(({ id, name, streamUrl, ptz }) => ({
      id, name, streamUrl,
      hasPtz: !!(ptz && ptz.ip),
      ptzCapabilities: ptz && ptz.ip ? (ptz.capabilities || ['pan', 'tilt']) : []
    }));
  res.json(cameras);
});

const wss = new WebSocketServer({ server, path: '/chat' });
setupChat(wss);

server.listen(config.port, () => {
  console.log(`Chicken Stream running at http://localhost:${config.port}`);
});
