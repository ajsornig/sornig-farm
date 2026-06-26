require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const cookieParser = require('cookie-parser');
const { WebSocketServer } = require('ws');
const config = require('../config.json');
const { initDb, getSession, hasPtzAccess } = require('./db');
const { setupChat } = require('./chat');
const apiRoutes = require('./routes/api');
const { initMailer } = require('./mailer');
const { securityHeaders, createRateLimiter } = require('./security');

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
  const isAdminUser = session && session.isAdmin;
  const canPtz = session && hasPtzAccess(session.username);

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
      ptzCapabilities: canPtz && ptz && ptz.ip ? (ptz.capabilities || ['pan', 'tilt']) : [],
      hidden: isCameraHidden(id)
    }));
  res.json(cameras);
});

app.get('/api/admin/cameras', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const session = getSession(token);
  if (!session || !session.isAdmin) return res.status(403).json({ error: 'Admin required' });

  const cameras = config.cameras
    .map(({ id, name, enabled }) => ({ id, name, enabled, hidden: isCameraHidden(id) }));
  res.json(cameras);
});

app.post('/api/admin/cameras/:id/toggle', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const session = getSession(token);
  if (!session || !session.isAdmin) return res.status(403).json({ error: 'Admin required' });

  const cam = config.cameras.find(c => c.id === req.params.id && c.enabled);
  if (!cam) return res.status(404).json({ error: 'Camera not found' });

  const currentlyHidden = isCameraHidden(cam.id);
  setCameraHidden(cam.id, !currentlyHidden);
  res.json({ id: cam.id, hidden: !currentlyHidden });
});

const CONFIG_PATH = path.join(__dirname, '../config.json');

app.post('/api/admin/cameras/:id/enable', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const session = getSession(token);
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
