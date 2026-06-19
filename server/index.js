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

const PRIVACY_FLAG = path.join(__dirname, '../.privacy-mode');

function isPrivacyMode() {
  return fs.existsSync(PRIVACY_FLAG);
}

const app = express();
const server = http.createServer(app);

initDb();
initMailer();

app.use(express.json());
app.use(cookieParser());

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

app.use(express.static(path.join(__dirname, '../public')));

app.get('/config/cameras', (req, res) => {
  if (isPrivacyMode()) {
    return res.json([]);
  }
  const cameras = config.cameras
    .filter(cam => cam.enabled)
    .map(({ id, name, streamUrl }) => ({ id, name, streamUrl }));
  res.json(cameras);
});

const wss = new WebSocketServer({ server, path: '/chat' });
setupChat(wss);

server.listen(config.port, () => {
  console.log(`Chicken Stream running at http://localhost:${config.port}`);
});
