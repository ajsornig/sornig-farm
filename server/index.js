const express = require('express');
const http = require('http');
const path = require('path');
const cookieParser = require('cookie-parser');
const { WebSocketServer } = require('ws');
const config = require('../config.json');
const { initDb } = require('./db');
const { setupChat } = require('./chat');
const apiRoutes = require('./routes/api');
const { authMiddleware } = require('./routes/auth');

const app = express();
const server = http.createServer(app);

initDb();

app.use(express.json());
app.use(cookieParser());

if (config.authEnabled) {
  app.use(authMiddleware);
}

app.use('/api', apiRoutes);

app.use(express.static(path.join(__dirname, '../public')));

app.get('/config/cameras', (req, res) => {
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
