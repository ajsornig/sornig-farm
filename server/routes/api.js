const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../../config.json');
const db = require('../db');
const { sendApprovalRequest, sendApprovalNotification, sendPasswordResetEmail, sendBroadcast } = require('../mailer');
const { atomicWriteJSON } = require('../atomic-write');
const { getClientIp } = require('../security');
const { sendPtzCommand, getPresets, gotoPreset, VALID_OPS } = require('../ptz');
const { createRateLimiter } = require('../security');

const router = express.Router();

const MIN_PASSWORD_LENGTH = 8;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

router.post('/register', async (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const result = db.createUser(username, password, false, email);
  if (result.error) {
    return res.status(400).json(result);
  }

  // If approval is required, send notification and don't log them in yet
  if (config.requireApproval && result.needsApproval) {
    await sendApprovalRequest(username, result.approvalToken);
    return res.json({
      success: true,
      pendingApproval: true,
      message: 'Account created! Please wait for admin approval.'
    });
  }

  const loginResult = db.loginUser(username, password);
  res.json(loginResult);
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const result = db.loginUser(username, password);
  if (result.error) {
    return res.status(401).json(result);
  }
  // Check if user is approved
  if (config.requireApproval && !db.isUserApproved(username)) {
    return res.json({
      success: true,
      pendingApproval: true,
      message: 'Your account is pending admin approval.'
    });
  }
  const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip;
  if (!result.isAdmin) {
    db.logActivity(result.username, 'login', { ip });
  }
  res.json({ ...result, approved: true, requireApproval: config.requireApproval || false });
});

router.post('/logout', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token) {
    db.logoutUser(token);
  }
  res.json({ success: true });
});

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }
  const result = db.createResetToken(email);
  if (result.error) {
    return res.json({ success: true, message: 'If an account with that email exists, a reset link has been sent.' });
  }
  await sendPasswordResetEmail(result.username, email, result.token);
  res.json({ success: true, message: 'If an account with that email exists, a reset link has been sent.' });
});

router.get('/reset-password/:token', (req, res) => {
  const user = db.getUserByResetToken(req.params.token);
  if (!user) {
    return res.send('<h1>Invalid or expired reset link</h1><p>This link has expired or is invalid. Please request a new one.</p><p><a href="/">Go to site</a></p>');
  }
  res.send(`
    <html><head><title>Reset Password - Sornig Farm</title>
    <style>body{font-family:Georgia,serif;background:#FDF6E3;display:flex;justify-content:center;align-items:center;min-height:100vh;}
    .box{background:#F5EDDA;padding:2rem;border-radius:12px;border:2px solid #5D4037;max-width:400px;width:100%;}
    h1{color:#8B2500;margin-bottom:1rem;font-size:1.5rem;}
    input{width:100%;padding:0.7rem;margin:0.5rem 0;border:2px solid #5D4037;border-radius:6px;font-size:1rem;box-sizing:border-box;}
    button{width:100%;padding:0.7rem;background:#2D5A27;color:#FDF6E3;border:none;border-radius:6px;font-size:1rem;cursor:pointer;margin-top:0.5rem;}
    button:hover{background:#3d7a37;} .err{color:#8B2500;margin-top:0.5rem;}</style></head>
    <body><div class="box"><h1>Reset Password</h1><p>Enter a new password for <strong>${escapeHtml(user.username)}</strong></p>
    <form id="f"><input type="password" id="p1" placeholder="New password" required minlength="8">
    <input type="password" id="p2" placeholder="Confirm password" required minlength="8">
    <button type="submit">Reset Password</button><p class="err" id="err"></p></form>
    <script>document.getElementById('f').onsubmit=async(e)=>{e.preventDefault();const p1=document.getElementById('p1').value;const p2=document.getElementById('p2').value;
    if(p1!==p2){document.getElementById('err').textContent='Passwords do not match';return;}
    const r=await fetch('/api/reset-password/${req.params.token}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({newPassword:p1})});
    const d=await r.json();if(d.success){document.querySelector('.box').innerHTML='<h1>Password Reset!</h1><p>Your password has been changed. You can now <a href="/">log in</a>.</p>';}
    else{document.getElementById('err').textContent=d.error||'Reset failed';}}</script></div></body></html>
  `);
});

router.post('/reset-password/:token', (req, res) => {
  const user = db.getUserByResetToken(req.params.token);
  if (!user) {
    return res.status(400).json({ error: 'Invalid or expired reset link' });
  }
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }
  const result = db.resetPassword(user.username, newPassword);
  if (result.error) {
    return res.status(400).json(result);
  }
  res.json({ success: true });
});

router.post('/change-password', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const session = db.getSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password required' });
  }
  const result = db.changePassword(session.username, currentPassword, newPassword);
  if (result.error) {
    return res.status(400).json(result);
  }
  res.json({ success: true });
});

router.get('/me', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (!token) {
    return res.json({ loggedIn: false });
  }
  const session = db.getSession(token);
  if (!session) {
    return res.json({ loggedIn: false });
  }
  const approved = db.isUserApproved(session.username);
  const user = db.getUser(session.username);
  const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip;
  if (!session.isAdmin) {
    db.logActivity(session.username, 'page_visit', { ip });
  }
  res.json({
    loggedIn: true,
    username: session.username,
    isAdmin: session.isAdmin,
    approved: approved,
    requireApproval: config.requireApproval,
    email: user ? user.email : null,
    createdAt: user ? user.createdAt : null
  });
});

router.post('/account/email', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const session = db.getSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const { email } = req.body;
  const result = db.updateUserEmail(session.username, email);
  if (result.error) {
    return res.status(400).json(result);
  }
  res.json({ success: true });
});

router.delete('/account', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const session = db.getSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (session.isAdmin) {
    return res.status(403).json({ error: 'Admin accounts cannot self-delete' });
  }
  const deleted = db.deleteUser(session.username);
  if (!deleted) {
    return res.status(404).json({ error: 'Account not found' });
  }
  res.json({ success: true });
});

function requireAdmin(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const session = db.getSession(token);
  if (!session || !session.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  req.session = session;
  next();
}

router.delete('/admin/chat', requireAdmin, (req, res) => {
  db.clearAllMessages();
  res.json({ success: true });
});

router.delete('/admin/chat/:messageId', requireAdmin, (req, res) => {
  const deleted = db.deleteMessage(req.params.messageId);
  if (deleted) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Message not found' });
  }
});

router.get('/admin/users', requireAdmin, (req, res) => {
  res.json(db.getAllUsers());
});

router.delete('/admin/users/:username', requireAdmin, (req, res) => {
  const deleted = db.deleteUser(req.params.username);
  if (deleted) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'User not found' });
  }
});

router.post('/admin/users/:username/reset-password', requireAdmin, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword) {
    return res.status(400).json({ error: 'New password required' });
  }
  const result = db.resetPassword(req.params.username, newPassword);
  if (result.error) {
    return res.status(400).json(result);
  }
  res.json({ success: true });
});

router.post('/admin/users/:username/email', requireAdmin, (req, res) => {
  const { email } = req.body;
  const result = db.updateUserEmail(req.params.username, email);
  if (result.error) {
    return res.status(400).json(result);
  }
  res.json({ success: true });
});

router.get('/admin/activity', requireAdmin, (req, res) => {
  res.json(db.getActivityLog());
});

router.delete('/admin/activity', requireAdmin, (req, res) => {
  db.clearActivityLog();
  res.json({ success: true });
});

router.delete('/admin/activity/:index', requireAdmin, (req, res) => {
  const index = parseInt(req.params.index);
  if (isNaN(index)) {
    return res.status(400).json({ error: 'Invalid index' });
  }
  const result = db.deleteActivityEntry(index);
  if (result) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Entry not found' });
  }
});

// Get pending users awaiting approval
router.get('/admin/pending', requireAdmin, (req, res) => {
  res.json(db.getPendingUsers());
});

// Approve user (from admin panel)
router.post('/admin/users/:username/approve', requireAdmin, async (req, res) => {
  const result = db.approveUser(req.params.username);
  if (result.error) {
    return res.status(400).json(result);
  }
  await sendApprovalNotification(req.params.username, result.email, true);
  res.json({ success: true });
});

// Deny user (from admin panel)
router.post('/admin/users/:username/deny', requireAdmin, async (req, res) => {
  const result = db.denyUser(req.params.username);
  if (result.error) {
    return res.status(400).json(result);
  }
  await sendApprovalNotification(req.params.username, result.email, false);
  res.json({ success: true });
});

// Approve via email link (no auth required, uses token)
router.get('/approve/:token', async (req, res) => {
  const user = db.getUserByApprovalToken(req.params.token);
  if (!user) {
    return res.send('<h1>Invalid or expired approval link</h1><p><a href="/">Go to site</a></p>');
  }
  const result = db.approveUser(user.username);
  if (result.error) {
    return res.send(`<h1>Error</h1><p>${escapeHtml(result.error)}</p>`);
  }
  await sendApprovalNotification(user.username, user.email, true);
  res.send(`<h1>Approved!</h1><p>User &quot;${escapeHtml(user.username)}&quot; has been approved.</p><p><a href="/">Go to site</a></p>`);
});

// Deny via email link (no auth required, uses token)
router.get('/deny/:token', async (req, res) => {
  const user = db.getUserByApprovalToken(req.params.token);
  if (!user) {
    return res.send('<h1>Invalid or expired link</h1><p><a href="/">Go to site</a></p>');
  }
  const result = db.denyUser(user.username);
  if (result.error) {
    return res.send(`<h1>Error</h1><p>${escapeHtml(result.error)}</p>`);
  }
  await sendApprovalNotification(user.username, user.email, false);
  res.send(`<h1>Denied</h1><p>User &quot;${escapeHtml(user.username)}&quot; has been denied and removed.</p><p><a href="/">Go to site</a></p>`);
});

router.get('/recordings', requireAdmin, (req, res) => {
  const recordingsDir = path.join(__dirname, '../../recordings');

  if (!fs.existsSync(recordingsDir)) {
    return res.json([]);
  }

  const files = fs.readdirSync(recordingsDir)
    .filter(f => f.endsWith('.mp4') || f.endsWith('.m3u8'))
    .map(filename => {
      const filepath = path.join(recordingsDir, filename);
      const stats = fs.statSync(filepath);
      return {
        filename,
        size: stats.size,
        created: stats.birthtime.toISOString()
      };
    })
    .sort((a, b) => new Date(b.created) - new Date(a.created));

  res.json(files);
});

router.get('/recordings/:filename', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(__dirname, '../../recordings', filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Recording not found' });
  }

  res.sendFile(filepath);
});

router.get('/timelapse', (req, res) => {
  const timelapseDir = path.join(__dirname, '../../public/timelapse');

  if (!fs.existsSync(timelapseDir)) {
    return res.json([]);
  }

  const files = fs.readdirSync(timelapseDir)
    .filter(f => f.endsWith('.mp4'))
    .map(filename => {
      const stats = fs.statSync(path.join(timelapseDir, filename));
      return {
        filename,
        url: `/timelapse/${filename}`,
        size: stats.size,
        created: stats.birthtime.toISOString()
      };
    })
    .sort((a, b) => new Date(b.created) - new Date(a.created));

  res.json(files);
});

router.get('/admin/timelapse-frames', requireAdmin, (req, res) => {
  const now = new Date();
  const today = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const cams = [
    { dir: path.join(__dirname, '../../timelapse/frames'), label: 'run' },
    { dir: path.join(__dirname, '../../timelapse/frames-coop'), label: 'coop' }
  ];

  const files = cams.flatMap(cam => {
    if (!fs.existsSync(cam.dir)) return [];
    return fs.readdirSync(cam.dir)
      .filter(f => f.endsWith('.jpg') && f.startsWith(today))
      .sort()
      .map(filename => ({
        filename,
        cam: cam.label,
        url: `/api/admin/timelapse-frames/${cam.label}/${filename}`,
        time: filename.replace(today + '_', '').replace('.jpg', '').replace(/(\d{2})(\d{2})/, '$1:$2')
      }));
  });

  res.json(files);
});

router.get('/admin/timelapse-frames/:cam/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const cam = req.params.cam;
  if (!/^\d{4}-\d{2}-\d{2}_\d{4}\.jpg$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  if (cam !== 'run' && cam !== 'coop') {
    return res.status(400).json({ error: 'Invalid camera' });
  }
  const dir = cam === 'coop' ? 'frames-coop' : 'frames';
  const filepath = path.join(__dirname, '../../timelapse', dir, filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Frame not found' });
  }

  res.sendFile(filepath);
});

router.delete('/admin/timelapse-frames/:cam/:filename', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.filename);
  const cam = req.params.cam;
  if (cam !== 'run' && cam !== 'coop') {
    return res.status(400).json({ error: 'Invalid camera' });
  }
  const dir = cam === 'coop' ? 'frames-coop' : 'frames';
  const filepath = path.join(__dirname, '../../timelapse', dir, filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Frame not found' });
  }

  fs.unlinkSync(filepath);
  res.json({ success: true });
});

router.get('/motion-captures', (req, res) => {
  const capturesDir = path.join(__dirname, '../../public/motion-captures');

  if (!fs.existsSync(capturesDir)) {
    return res.json([]);
  }

  const files = fs.readdirSync(capturesDir)
    .filter(f => f.endsWith('.jpg'))
    .map(filename => {
      const stats = fs.statSync(path.join(capturesDir, filename));
      return {
        filename,
        url: `/motion-captures/${filename}`,
        created: stats.birthtime.toISOString()
      };
    })
    .sort((a, b) => new Date(b.created) - new Date(a.created))
    .slice(0, 50);

  res.json(files);
});

router.get('/admin/motion-pending', requireAdmin, (req, res) => {
  const pendingDir = path.join(__dirname, '../../public/motion-captures/pending');

  if (!fs.existsSync(pendingDir)) {
    return res.json([]);
  }

  const files = fs.readdirSync(pendingDir)
    .filter(f => f.endsWith('.jpg'))
    .map(filename => {
      const stats = fs.statSync(path.join(pendingDir, filename));
      return {
        filename,
        url: `/motion-captures/pending/${filename}`,
        created: stats.birthtime.toISOString()
      };
    })
    .sort((a, b) => new Date(b.created) - new Date(a.created));

  res.json(files);
});

router.post('/admin/motion-pending/:filename/approve', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.filename);
  const pendingDir = path.join(__dirname, '../../public/motion-captures/pending');
  const approvedDir = path.join(__dirname, '../../public/motion-captures');
  const src = path.join(pendingDir, filename);
  const dest = path.join(approvedDir, filename);

  if (!fs.existsSync(src)) {
    return res.status(404).json({ error: 'File not found' });
  }

  fs.renameSync(src, dest);
  res.json({ success: true });
});

router.post('/admin/motion-pending/:filename/reject', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.filename);
  const pendingDir = path.join(__dirname, '../../public/motion-captures/pending');
  const filepath = path.join(pendingDir, filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  fs.unlinkSync(filepath);
  res.json({ success: true });
});

router.delete('/admin/motion-captures/:filename', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(__dirname, '../../public/motion-captures', filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  fs.unlinkSync(filepath);
  res.json({ success: true });
});

// --- Chick Album ---

const CHICK_ALBUM_RE = /^chick-\d{4}-\d{2}-\d{2}_\d{6}\.jpg$/;

router.get('/chick-album', (req, res) => {
  const albumDir = path.join(__dirname, '../../public/chick-album');

  if (!fs.existsSync(albumDir)) {
    return res.json([]);
  }

  const files = fs.readdirSync(albumDir)
    .filter(f => f.endsWith('.jpg'))
    .map(filename => {
      const stats = fs.statSync(path.join(albumDir, filename));
      return {
        filename,
        url: `/chick-album/${filename}`,
        created: stats.birthtime.toISOString()
      };
    })
    .sort((a, b) => new Date(b.created) - new Date(a.created))
    .slice(0, 100);

  res.json(files);
});

router.get('/admin/chick-album/pending', requireAdmin, (req, res) => {
  const pendingDir = path.join(__dirname, '../../public/chick-album/pending');

  if (!fs.existsSync(pendingDir)) {
    return res.json([]);
  }

  const files = fs.readdirSync(pendingDir)
    .filter(f => f.endsWith('.jpg'))
    .map(filename => {
      const stats = fs.statSync(path.join(pendingDir, filename));
      return {
        filename,
        url: `/chick-album/pending/${filename}`,
        created: stats.birthtime.toISOString()
      };
    })
    .sort((a, b) => new Date(b.created) - new Date(a.created));

  res.json(files);
});

router.post('/admin/chick-album/pending/:filename/approve', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!CHICK_ALBUM_RE.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const pendingDir = path.join(__dirname, '../../public/chick-album/pending');
  const albumDir = path.join(__dirname, '../../public/chick-album');
  const src = path.join(pendingDir, filename);
  const dest = path.join(albumDir, filename);

  if (!fs.existsSync(src)) {
    return res.status(404).json({ error: 'File not found' });
  }

  fs.renameSync(src, dest);
  res.json({ success: true });
});

router.post('/admin/chick-album/pending/:filename/reject', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.filename);
  const pendingDir = path.join(__dirname, '../../public/chick-album/pending');
  const filepath = path.join(pendingDir, filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  fs.unlinkSync(filepath);
  res.json({ success: true });
});

router.post('/admin/chick-album/approve-all', requireAdmin, (req, res) => {
  const pendingDir = path.join(__dirname, '../../public/chick-album/pending');
  const albumDir = path.join(__dirname, '../../public/chick-album');

  if (!fs.existsSync(pendingDir)) {
    return res.json({ success: true, count: 0 });
  }

  const files = fs.readdirSync(pendingDir).filter(f => CHICK_ALBUM_RE.test(f));
  for (const f of files) {
    fs.renameSync(path.join(pendingDir, f), path.join(albumDir, f));
  }
  res.json({ success: true, count: files.length });
});

router.post('/admin/chick-album/reject-all', requireAdmin, (req, res) => {
  const pendingDir = path.join(__dirname, '../../public/chick-album/pending');

  if (!fs.existsSync(pendingDir)) {
    return res.json({ success: true, count: 0 });
  }

  const files = fs.readdirSync(pendingDir).filter(f => f.endsWith('.jpg'));
  for (const f of files) {
    fs.unlinkSync(path.join(pendingDir, f));
  }
  res.json({ success: true, count: files.length });
});

router.delete('/admin/chick-album/:filename', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(__dirname, '../../public/chick-album', filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  fs.unlinkSync(filepath);
  res.json({ success: true });
});

router.get('/status', (req, res) => {
  res.json({
    authEnabled: config.authEnabled,
    requireApproval: config.requireApproval || false,
    cameraCount: config.cameras.filter(c => c.enabled).length,
    recordingEnabled: config.recording.enabled
  });
});

router.get('/stats', (req, res) => {
  const stats = db.getStats();
  // Round visitor coordinates (~11km) so the public map can't be used to
  // pinpoint individual visitors.
  const visitors = stats.visitors.map(v => ({
    lat: Math.round(v.lat * 10) / 10,
    lng: Math.round(v.lng * 10) / 10,
    city: v.city,
    country: v.country
  }));
  res.json({ totalViews: stats.totalViews, visitors });
});

let weatherCache = { data: null, fetchedAt: 0 };

router.get('/weather', async (req, res) => {
  const now = Date.now();
  if (weatherCache.data && now - weatherCache.fetchedAt < 15 * 60 * 1000) {
    return res.json(weatherCache.data);
  }

  try {
    // Lapeer, MI coordinates
    const lat = 43.05;
    const lng = -83.32;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FDetroit`;
    const response = await fetch(url);
    const data = await response.json();

    const current = data.current;
    const weather = {
      temp: Math.round(current.temperature_2m),
      humidity: current.relative_humidity_2m,
      windSpeed: Math.round(current.wind_speed_10m),
      code: current.weather_code,
      description: getWeatherDescription(current.weather_code)
    };

    weatherCache = { data: weather, fetchedAt: now };
    res.json(weather);
  } catch (err) {
    console.error('Weather fetch failed:', err.message);
    if (weatherCache.data) {
      return res.json(weatherCache.data);
    }
    res.status(503).json({ error: 'Weather unavailable' });
  }
});

function getWeatherDescription(code) {
  const descriptions = {
    0: 'Clear', 1: 'Mostly Clear', 2: 'Partly Cloudy', 3: 'Overcast',
    45: 'Foggy', 48: 'Icy Fog', 51: 'Light Drizzle', 53: 'Drizzle',
    55: 'Heavy Drizzle', 61: 'Light Rain', 63: 'Rain', 65: 'Heavy Rain',
    71: 'Light Snow', 73: 'Snow', 75: 'Heavy Snow', 77: 'Snow Grains',
    80: 'Light Showers', 81: 'Showers', 82: 'Heavy Showers',
    85: 'Light Snow Showers', 86: 'Snow Showers',
    95: 'Thunderstorm', 96: 'Hail Thunderstorm', 99: 'Heavy Hail Storm'
  };
  return descriptions[code] || 'Unknown';
}

// --- Timelapse Analytics ---

const ANALYTICS_FILE = path.join(__dirname, '../../data/timelapse-analytics.json');

function loadAnalytics() {
  try {
    if (fs.existsSync(ANALYTICS_FILE)) {
      return JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Failed to load analytics:', err);
  }
  return { events: [], summary: {} };
}

function saveAnalytics(data) {
  atomicWriteJSON(ANALYTICS_FILE, data);
}

const VIDEO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_SUMMARY_VIDEOS = 500;

router.post('/timelapse/analytics', (req, res) => {
  const { video, event, duration, watchedSeconds } = req.body;
  if (!video || !event) return res.status(400).json({ error: 'Missing fields' });

  // Validate the video key: it becomes an object key in the summary map, so an
  // attacker-controlled value could otherwise grow the file/map without bound.
  if (typeof video !== 'string' || !VIDEO_RE.test(video)) {
    return res.status(400).json({ error: 'Invalid video' });
  }

  const allowed = ['play', 'pause', 'ended', 'timeupdate'];
  if (!allowed.includes(event)) return res.status(400).json({ error: 'Invalid event' });

  const analytics = loadAnalytics();

  const entry = {
    video,
    event,
    duration: Number(duration) || 0,
    watchedSeconds: Number(watchedSeconds) || 0,
    timestamp: new Date().toISOString(),
    ip: getClientIp(req)
  };

  analytics.events.push(entry);

  // Update summary, but cap the number of distinct video keys so a flood of
  // bogus video names can't grow the summary map indefinitely.
  const known = Object.prototype.hasOwnProperty.call(analytics.summary, video);
  if (known || Object.keys(analytics.summary).length < MAX_SUMMARY_VIDEOS) {
    if (!known) {
      analytics.summary[video] = { plays: 0, completions: 0, totalWatchSeconds: 0 };
    }
    const s = analytics.summary[video];
    if (event === 'play') s.plays++;
    if (event === 'ended') s.completions++;
    if (event === 'pause' || event === 'ended') {
      s.totalWatchSeconds += entry.watchedSeconds;
    }
  }

  // Keep last 1000 events to avoid unbounded growth
  if (analytics.events.length > 1000) {
    analytics.events = analytics.events.slice(-500);
  }

  saveAnalytics(analytics);
  res.json({ ok: true });
});

router.get('/timelapse/stats', (req, res) => {
  const analytics = loadAnalytics();
  const publicStats = {};
  for (const [video, data] of Object.entries(analytics.summary)) {
    publicStats[video] = { plays: data.plays, completions: data.completions };
  }
  res.json(publicStats);
});

router.get('/admin/timelapse-analytics', requireAdmin, (req, res) => {
  const analytics = loadAnalytics();
  res.json(analytics);
});

// --- Infrastructure Dashboard ---

const WIFI_LOG = path.join(__dirname, '../../logs/wifi-monitor.log');
const INFRA_HISTORY_COUNT = 60;

function parseInfraLine(line) {
  const parts = line.split(' | ');
  if (parts.length < 7) return null;

  const timestamp = parts[0].trim();

  const eth0Match = parts[1].match(/eth0=(\w+)@(\d+|\?)Mbps/);
  const eth0 = eth0Match
    ? { state: eth0Match[1], speed: eth0Match[2] === '?' ? null : Number(eth0Match[2]) }
    : { state: 'UNKNOWN', speed: null };

  const wlan0Match = parts[2].match(/wlan0=(-?\d+|\?)dBm/);
  const wlan0 = { signal: wlan0Match && wlan0Match[1] !== '?' ? Number(wlan0Match[1]) : null };

  let wlan1 = { signal: null };
  let pingIdx = 3;

  if (parts.length >= 8) {
    const wlan1Match = parts[3].match(/wlan1=(-?\d+|\?)dBm/);
    wlan1 = { signal: wlan1Match && wlan1Match[1] !== '?' ? Number(wlan1Match[1]) : null };
    pingIdx = 4;
  }

  const pingSection = parts[pingIdx].trim();
  const parsePing = (name) => {
    const m = pingSection.match(new RegExp(name + '=([\\d.]+|FAIL)ms'));
    if (!m) return { ms: null, ok: false };
    return m[1] === 'FAIL' ? { ms: null, ok: false } : { ms: parseFloat(m[1]), ok: true };
  };

  const streamSection = parts[pingIdx + 1].trim();
  const parseStream = (name) => {
    const m = streamSection.match(new RegExp(name + '=(\\d+|NO_FILE)s'));
    if (!m) return { age: null, ok: false };
    return m[1] === 'NO_FILE' ? { age: null, ok: false } : { age: Number(m[1]), ok: Number(m[1]) <= 30 };
  };

  const restartsMatch = parts[pingIdx + 2].match(/restarts=(\d+)\/(\d+)/);
  const ffmpegMatch = parts[pingIdx + 3] && parts[pingIdx + 3].match(/ffmpeg=(\d+)/);

  let system = { cpu: null, memUsed: null, memTotal: null, load: null, temp: null };
  const sysSection = parts[pingIdx + 4];
  if (sysSection) {
    const cpuM = sysSection.match(/cpu=([\d.]+|[?])%/);
    const memM = sysSection.match(/mem=(\d+)\/(\d+)MB/);
    const loadM = sysSection.match(/load=([\d.]+|[?])/);
    const tempM = sysSection.match(/temp=([\d.]+|[?])C/);
    system = {
      cpu: cpuM && cpuM[1] !== '?' ? parseFloat(cpuM[1]) : null,
      memUsed: memM ? Number(memM[1]) : null,
      memTotal: memM ? Number(memM[2]) : null,
      load: loadM && loadM[1] !== '?' ? parseFloat(loadM[1]) : null,
      temp: tempM && tempM[1] !== '?' ? parseFloat(tempM[1]) : null
    };
  }

  return {
    timestamp,
    eth0,
    wlan0,
    wlan1,
    pings: { cam1: parsePing('cam1'), cam2: parsePing('cam2'), wavlink: parsePing('wavlink') },
    streams: { stream1: parseStream('stream1'), stream2: parseStream('stream2') },
    restarts: restartsMatch ? { cam1: Number(restartsMatch[1]), cam2: Number(restartsMatch[2]) } : { cam1: 0, cam2: 0 },
    ffmpegCount: ffmpegMatch ? Number(ffmpegMatch[1]) : 0,
    system
  };
}

function generateInfraAlerts(entry) {
  const alerts = [];
  if (!entry) return [{ level: 'warning', message: 'No monitoring data available' }];

  if (!entry.pings.cam1.ok) alerts.push({ level: 'critical', message: 'Chicken Run camera ping FAILED' });
  if (!entry.pings.cam2.ok) alerts.push({ level: 'critical', message: 'Chicken Coop camera ping FAILED' });
  if (!entry.streams.stream1.ok) {
    alerts.push({ level: 'critical', message: entry.streams.stream1.age === null ? 'Stream 1 NO_FILE' : `Stream 1 stale (${entry.streams.stream1.age}s)` });
  }
  if (!entry.streams.stream2.ok) {
    alerts.push({ level: 'critical', message: entry.streams.stream2.age === null ? 'Stream 2 NO_FILE' : `Stream 2 stale (${entry.streams.stream2.age}s)` });
  }
  if (entry.eth0.state !== 'up') alerts.push({ level: 'critical', message: 'eth0 link DOWN' });
  if (entry.ffmpegCount < 2) alerts.push({ level: 'warning', message: `Only ${entry.ffmpegCount} ffmpeg process(es) running` });
  if (entry.wlan1.signal === null) {
    alerts.push({ level: 'warning', message: 'Primary uplink (wlan1) signal lost — failover active' });
    if (entry.wlan0.signal !== null && entry.wlan0.signal < -70) {
      alerts.push({ level: 'warning', message: `Failover WiFi signal weak (${entry.wlan0.signal} dBm)` });
    }
  }
  if (entry.system.cpu !== null && entry.system.cpu > 80) {
    alerts.push({ level: 'critical', message: `CPU usage high (${entry.system.cpu.toFixed(1)}%)` });
  }
  if (entry.system.temp !== null && entry.system.temp > 75) {
    alerts.push({ level: 'warning', message: `CPU temperature high (${entry.system.temp.toFixed(1)}°C)` });
  }
  if (entry.system.temp !== null && entry.system.temp > 82) {
    alerts.push({ level: 'critical', message: `CPU temperature critical (${entry.system.temp.toFixed(1)}°C) — throttling likely` });
  }

  return alerts;
}

router.get('/admin/infra', requireAdmin, (req, res) => {
  try {
    if (!fs.existsSync(WIFI_LOG)) {
      return res.json({ success: true, latest: null, history: [], alerts: [{ level: 'warning', message: 'No monitoring data available' }] });
    }

    const raw = fs.readFileSync(WIFI_LOG, 'utf8');
    const lines = raw.split('\n').filter(Boolean).slice(-INFRA_HISTORY_COUNT);
    const history = lines.map(parseInfraLine).filter(Boolean);
    const latest = history.length > 0 ? history[history.length - 1] : null;
    const alerts = generateInfraAlerts(latest);

    res.json({ success: true, latest, history, alerts });
  } catch (err) {
    console.error('Infra endpoint error:', err);
    res.status(500).json({ error: 'Failed to read infrastructure data' });
  }
});

// --- Email Broadcast ---

router.get('/admin/broadcast/recipients', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const session = db.getSession(token);
  if (!session || !session.isAdmin) return res.status(403).json({ error: 'Admin only' });

  const users = db.getAllUsers().filter(u => u.email && u.approved);
  res.json(users.map(u => ({ username: u.username, email: u.email })));
});

router.post('/admin/broadcast', async (req, res) => {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const session = db.getSession(token);
  if (!session || !session.isAdmin) return res.status(403).json({ error: 'Admin only' });

  const { subject, message } = req.body;
  if (!subject || !message) return res.status(400).json({ error: 'Subject and message required' });
  if (subject.length > 200) return res.status(400).json({ error: 'Subject too long' });
  if (message.length > 5000) return res.status(400).json({ error: 'Message too long' });

  const users = db.getAllUsers().filter(u => u.email && u.approved);
  const recipients = users.map(u => ({ username: u.username, email: u.email }));
  const results = await sendBroadcast(subject, message, recipients);
  res.json(results);
});

// --- PTZ Access Management ---

router.post('/admin/users/:username/ptz', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const session = db.getSession(token);
  if (!session || !session.isAdmin) return res.status(403).json({ error: 'Admin only' });

  const { enabled } = req.body;
  const result = db.setPtzAccess(req.params.username, enabled);
  if (result.error) return res.status(404).json(result);
  res.json({ success: true, username: req.params.username, ptzAccess: !!enabled });
});

// --- PTZ Camera Control ---

function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const session = db.getSession(token);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  req.session = session;
  next();
}

function requirePtzAccess(req, res, next) {
  if (!db.hasPtzAccess(req.session.username)) {
    return res.status(403).json({ error: 'PTZ access not granted' });
  }
  next();
}

function findPtzCamera(id) {
  const cam = config.cameras.find(c => c.id === id && c.enabled);
  if (!cam) return null;
  if (!cam.ptz || !cam.ptz.ip) return null;
  return cam;
}

const ptzLimiter = createRateLimiter({ windowMs: 1000, max: 20, message: 'PTZ rate limit exceeded' });

router.post('/camera/:id/ptz', requireAuth, requirePtzAccess, ptzLimiter, async (req, res) => {
  const cam = findPtzCamera(req.params.id);
  if (!cam) return res.status(404).json({ error: 'Camera not found or does not support PTZ' });

  const { op, speed } = req.body;
  if (!op || !VALID_OPS.includes(op)) {
    return res.status(400).json({ error: `Invalid op. Valid: ${VALID_OPS.join(', ')}` });
  }

  try {
    const result = await sendPtzCommand(cam, op, speed || 32);
    res.json(result);
  } catch (err) {
    console.error('PTZ command failed:', err.message);
    res.status(502).json({ error: 'Failed to send PTZ command to camera' });
  }
});

router.get('/camera/:id/presets', requireAuth, requirePtzAccess, async (req, res) => {
  const cam = findPtzCamera(req.params.id);
  if (!cam) return res.status(404).json({ error: 'Camera not found or does not support PTZ' });

  try {
    const presets = await getPresets(cam);
    res.json(presets);
  } catch (err) {
    console.error('Get presets failed:', err.message);
    res.status(502).json({ error: 'Failed to get presets from camera' });
  }
});

router.post('/camera/:id/preset/:presetId', requireAuth, requirePtzAccess, async (req, res) => {
  const cam = findPtzCamera(req.params.id);
  if (!cam) return res.status(404).json({ error: 'Camera not found or does not support PTZ' });

  const presetId = parseInt(req.params.presetId);
  if (isNaN(presetId) || presetId < 0 || presetId > 63) {
    return res.status(400).json({ error: 'Invalid preset ID' });
  }

  try {
    const result = await gotoPreset(cam, presetId, req.body.speed || 32);
    res.json(result);
  } catch (err) {
    console.error('Goto preset failed:', err.message);
    res.status(502).json({ error: 'Failed to move to preset' });
  }
});

module.exports = router;
