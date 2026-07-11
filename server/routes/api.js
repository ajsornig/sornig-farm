const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../../config.json');
const db = require('../db');
const { sendApprovalRequest, sendApprovalNotification, sendPasswordResetEmail, sendBroadcast } = require('../mailer');
const { atomicWriteJSON } = require('../atomic-write');
const { getClientIp } = require('../security');
const { geolocateIP } = require('../geo');
const { getVisitedLocations, recordVisitedLocation, removeVisitedLocation } = require('../visited-locations');
const { sendPtzCommand, getPresets, gotoPreset, setPreset, removePreset, VALID_OPS } = require('../ptz');
const { getAiConfig, setAiTrack, setTrackTypes, setTrackBackTimes, getPtzGuard, setPtzGuard } = require('../reolink-api');
const { createRateLimiter } = require('../security');
const { readLogTail, parseInfraLine, generateInfraAlerts, INFRA_HISTORY_COUNT } = require('../infra');
const { getCamStates } = require('../camera-state');
const { execSync } = require('child_process');

const { isUsernameClean } = require('../profanity');

const router = express.Router();

const MIN_PASSWORD_LENGTH = 8;

// httpOnly session cookie — the credential used to gate private media (streams,
// saved frames/videos) that <video>/<img> requests can't attach a header to.
// Secure so it is only ever sent over the Cloudflare HTTPS edge; SameSite=Lax so
// same-origin media/page loads carry it. Mirrors the 7-day server session TTL.
const SESSION_COOKIE = 'sf_session';
const SESSION_COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
function setSessionCookie(req, res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    // Secure only when the request actually arrived over HTTPS (true in prod
    // behind the Cloudflare tunnel via X-Forwarded-Proto; false on plain-http
    // localhost so local testing still works).
    secure: !!req.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE
  });
}
function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

function sessionFromRequest(req) {
  // Cookie (browser) or x-auth-token header (API clients) only. No ?token= query
  // fallback: a session token in a URL is CSRF-exempt and leaks into logs/history.
  const token = (req.cookies && req.cookies[SESSION_COOKIE]) || req.headers['x-auth-token'];
  return token ? db.getSession(token) : null;
}

// Gate for private viewer content: any logged-in, approved account (or admin).
function requireApprovedViewer(req, res, next) {
  const session = sessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (config.requireApproval && !db.isUserApproved(session.username)) {
    return res.status(403).json({ error: 'Account not approved' });
  }
  req.session = session;
  next();
}

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
  if (!db.USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, and . _ - only' });
  }
  if (!isUsernameClean(username)) {
    return res.status(400).json({ error: 'That username is not allowed' });
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
  if (loginResult.token) setSessionCookie(req, res, loginResult.token);
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
    // loginUser already created a session; discard it since it's never issued.
    if (result.token) db.logoutUser(result.token);
    return res.json({
      success: true,
      pendingApproval: true,
      message: 'Your account is pending admin approval.'
    });
  }
  const ip = getClientIp(req);
  if (!result.isAdmin) {
    geolocateIP(ip).then(geo => {
      db.logActivity(result.username, 'login', { ip, ...(geo || {}) });
      if (geo) recordVisitedLocation(result.username, geo);
    });
  }
  if (result.token) setSessionCookie(req, res, result.token);
  res.json({ ...result, approved: true, requireApproval: config.requireApproval || false });
});

router.post('/logout', (req, res) => {
  const token = req.headers['x-auth-token'] || (req.cookies && req.cookies[SESSION_COOKIE]);
  if (token) {
    db.logoutUser(token);
  }
  clearSessionCookie(res);
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
    const r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({newPassword:p1})});
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
  const session = sessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password required' });
  }
  const currentToken = (req.cookies && req.cookies[SESSION_COOKIE]) || req.headers['x-auth-token'];
  const result = db.changePassword(session.username, currentPassword, newPassword, currentToken);
  if (result.error) {
    return res.status(400).json(result);
  }
  res.json({ success: true });
});

router.get('/me', (req, res) => {
  const token = req.headers['x-auth-token'] || (req.cookies && req.cookies[SESSION_COOKIE]);
  if (!token) {
    return res.json({ loggedIn: false });
  }
  const session = db.getSession(token);
  if (!session) {
    return res.json({ loggedIn: false });
  }
  // (Re)issue the cookie on every /me so it stays fresh and any client still
  // holding only a header token is upgraded to the httpOnly cookie.
  setSessionCookie(req, res, token);
  const approved = db.isUserApproved(session.username);
  const user = db.getUser(session.username);
  const ip = getClientIp(req);
  if (!session.isAdmin) {
    geolocateIP(ip).then(geo => {
      db.logActivity(session.username, 'page_visit', { ip, ...(geo || {}) });
      if (geo) recordVisitedLocation(session.username, geo);
    });
  }
  res.json({
    loggedIn: true,
    username: session.username,
    isAdmin: session.isAdmin,
    approved: approved,
    requireApproval: config.requireApproval,
    email: user ? user.email : null,
    emailOptOut: user ? !!user.emailOptOut : false,
    createdAt: user ? user.createdAt : null
  });
});

router.post('/account/email', (req, res) => {
  const session = sessionFromRequest(req);
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

router.post('/account/email-preferences', (req, res) => {
  const session = sessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { optOut } = req.body;
  const result = db.setEmailOptOut(session.username, optOut);
  if (result.error) return res.status(400).json(result);
  res.json({ success: true });
});

router.get('/unsubscribe/:token', (req, res) => {
  const user = db.getUserByUnsubscribeToken(req.params.token);
  if (!user) {
    return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:2rem;"><h2>Invalid Link</h2><p>This unsubscribe link is not valid or has expired.</p></body></html>');
  }
  db.setEmailOptOut(user.username, true);
  res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:2rem;"><h2>Unsubscribed</h2><p>${user.username}, you have been unsubscribed from Sornig Farm email updates.</p><p>You can re-subscribe anytime from your <a href="/account.html">account settings</a>.</p></body></html>`);
});

router.delete('/account', (req, res) => {
  const session = sessionFromRequest(req);
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
  // Accept the httpOnly cookie as well as the header/query token, so admin-only
  // <img>/<video> resources (which can't set a header) still authenticate.
  const session = sessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (!session.isAdmin) {
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

// Permanent worldwide visitor map: cell-bucketed pins (0.1 deg) with running
// visit counts and per-visitor last-seen timestamps. Shared store backs both
// the admin visitor map and the public /stats map — the public route rounds
// coords (already rounded at storage) and drops usernames for privacy.
router.get('/admin/visitor-map', requireAdmin, (req, res) => {
  const locations = Object.entries(getVisitedLocations()).map(([key, v]) => ({
    key,
    lat: v.lat,
    lng: v.lng,
    city: v.city,
    country: v.country,
    count: v.count,
    firstSeen: v.firstSeen,
    lastSeen: v.lastSeen,
    visitors: Object.entries(v.visitors || {})
      .map(([username, lastSeen]) => ({ username, lastSeen }))
      .sort((a, b) => b.lastSeen - a.lastSeen)
  }));
  res.json(locations);
});

router.delete('/admin/visitor-map/:key', requireAdmin, (req, res) => {
  const ok = removeVisitedLocation(req.params.key);
  if (!ok) return res.status(404).json({ error: 'Pin not found' });
  res.json({ success: true });
});

router.delete('/admin/activity', requireAdmin, (req, res) => {
  db.clearActivityLog();
  res.json({ success: true });
});

router.delete('/admin/activity/:timestamp', requireAdmin, (req, res) => {
  const timestamp = parseInt(req.params.timestamp);
  const username = typeof req.query.username === 'string' ? req.query.username : '';
  if (isNaN(timestamp)) {
    return res.status(400).json({ error: 'Invalid timestamp' });
  }
  const result = db.deleteActivityEntry(timestamp, username);
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

// --- Favorites ---

router.get('/favorites', requireApprovedViewer, (req, res) => {
  const favorites = db.getFavorites();
  const favDir = path.join(__dirname, '../../public/favorites');
  const result = favorites.filter(f => fs.existsSync(path.join(favDir, f.filename))).map(f => ({
    filename: f.filename,
    cam: f.cam,
    starred: f.starred,
    url: `/favorites/${f.filename}`
  }));
  res.json(result);
});

router.post('/admin/favorites', requireAdmin, (req, res) => {
  const { cam, source } = req.body;
  // Strip any path components and validate the frame-name shape, matching the
  // sibling frame endpoints — otherwise a name like ../../etc/passwd traverses
  // out of the frames dir on both the read and the write.
  const filename = req.body.filename ? path.basename(req.body.filename) : '';
  if (!cam || !filename) return res.status(400).json({ error: 'Missing cam or filename' });
  if (!['run', 'coop', 'chick'].includes(cam)) return res.status(400).json({ error: 'Invalid cam' });
  if (!/^\d{4}-\d{2}-\d{2}_\d{4,6}\.jpg$/.test(filename)) return res.status(400).json({ error: 'Invalid filename' });

  const favFilename = `${cam}_${filename}`;
  const favDir = path.join(__dirname, '../../public/favorites');
  if (!fs.existsSync(favDir)) fs.mkdirSync(favDir, { recursive: true });

  let srcPath;
  if (source === 'highlights') {
    srcPath = path.join(__dirname, '../../public/highlights', `${cam}_${filename}`);
  } else {
    srcPath = path.join(__dirname, '../../motion-timelapse', `frames-${cam}`, filename);
  }

  if (!fs.existsSync(srcPath)) return res.status(404).json({ error: 'Source frame not found' });

  fs.copyFileSync(srcPath, path.join(favDir, favFilename));
  db.addFavorite(favFilename, cam);
  res.json({ success: true, filename: favFilename });
});

router.delete('/admin/favorites/:filename', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(__dirname, '../../public/favorites', filename);

  if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  db.removeFavorite(filename);
  res.json({ success: true });
});

// --- Highlights ---

router.get('/admin/highlights', requireAdmin, (req, res) => {
  const hlDir = path.join(__dirname, '../../public/highlights');
  if (!fs.existsSync(hlDir)) return res.json({ dates: {} });

  const files = fs.readdirSync(hlDir)
    .filter(f => f.endsWith('.jpg'))
    .sort();

  const dates = {};
  files.forEach(f => {
    const match = f.match(/^(run|coop|chick)_(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(\d{2})\.jpg$/);
    if (!match) return;
    const [, cam, date, h, m, s] = match;
    if (!dates[date]) dates[date] = [];
    dates[date].push({ filename: f, cam, time: `${h}:${m}:${s}`, url: `/highlights/${f}` });
  });

  res.json({ dates });
});

router.get('/motion-timelapse', requireApprovedViewer, (req, res) => {
  const motionTimelapseDir = path.join(__dirname, '../../public/motion-timelapse');

  if (!fs.existsSync(motionTimelapseDir)) {
    return res.json([]);
  }

  const files = fs.readdirSync(motionTimelapseDir)
    .filter(f => f.endsWith('.mp4'))
    .map(filename => {
      const stats = fs.statSync(path.join(motionTimelapseDir, filename));
      return {
        filename,
        url: `/motion-timelapse/${filename}`,
        size: stats.size,
        created: stats.birthtime.toISOString()
      };
    })
    .sort((a, b) => new Date(b.created) - new Date(a.created));

  res.json(files);
});

router.get('/admin/motion-capture-frames', requireAdmin, (req, res) => {
  const now = new Date();
  const today = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - now.getTimezoneOffset() * 60000 - 86400000).toISOString().slice(0, 10);
  const cams = [
    { dir: path.join(__dirname, '../../motion-timelapse/frames-run'), label: 'run' },
    { dir: path.join(__dirname, '../../motion-timelapse/frames-coop'), label: 'coop' },
    { dir: path.join(__dirname, '../../motion-timelapse/frames-chick'), label: 'chick' }
  ];

  const files = cams.flatMap(cam => {
    if (!fs.existsSync(cam.dir)) return [];
    return fs.readdirSync(cam.dir)
      .filter(f => f.endsWith('.jpg') && (f.startsWith(today) || f.startsWith(yesterday)))
      .sort()
      .map(filename => ({
        filename,
        cam: cam.label,
        url: `/api/admin/motion-capture-frames/${cam.label}/${filename}`,
        time: filename.replace(/^\d{4}-\d{2}-\d{2}_/, '').replace('.jpg', '').replace(/(\d{2})(\d{2})(\d{2})?/, (_, h, m, s) => s ? `${h}:${m}:${s}` : `${h}:${m}`)
      }));
  });

  res.json(files);
});

router.get('/admin/motion-capture-frames/:cam/:filename', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.filename);
  const cam = req.params.cam;
  if (!/^\d{4}-\d{2}-\d{2}_\d{4,6}\.jpg$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  if (cam !== 'run' && cam !== 'coop' && cam !== 'chick') {
    return res.status(400).json({ error: 'Invalid camera' });
  }
  const filepath = path.join(__dirname, '../../motion-timelapse', `frames-${cam}`, filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Frame not found' });
  }

  res.sendFile(filepath);
});

router.delete('/admin/motion-capture-frames/:cam/:filename', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.filename);
  const cam = req.params.cam;
  if (cam !== 'run' && cam !== 'coop' && cam !== 'chick') {
    return res.status(400).json({ error: 'Invalid camera' });
  }
  const filepath = path.join(__dirname, '../../motion-timelapse', `frames-${cam}`, filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Frame not found' });
  }

  fs.unlinkSync(filepath);
  res.json({ success: true });
});

// --- Chick Growth Timelapse ---

router.get('/chick-growth', requireApprovedViewer, (req, res) => {
  const growthDir = path.join(__dirname, '../../public/chick-growth');
  if (!fs.existsSync(growthDir)) return res.json({ frames: [], video: null });

  const frames = fs.readdirSync(growthDir)
    .filter(f => f.endsWith('.jpg') && !f.includes('_'))  // YYYY-MM-DD.jpg only, not pending _1 _2 etc
    .sort()
    .map(filename => {
      const mtime = fs.statSync(path.join(growthDir, filename)).mtimeMs;
      return {
        filename,
        url: `/chick-growth/${filename}?v=${Math.floor(mtime)}`,
        date: filename.replace('.jpg', '')
      };
    });

  const videoFile = 'chick-growth.mp4';
  const videoPath = path.join(growthDir, videoFile);
  const videoMtime = fs.existsSync(videoPath) ? Math.floor(fs.statSync(videoPath).mtimeMs) : 0;
  const video = fs.existsSync(videoPath) ? { url: `/chick-growth/${videoFile}?v=${videoMtime}`, size: fs.statSync(videoPath).size } : null;

  res.json({ frames, video });
});

router.get('/admin/chick-growth/pending', requireAdmin, (req, res) => {
  const pendingDir = path.join(__dirname, '../../public/chick-growth/pending');
  if (!fs.existsSync(pendingDir)) return res.json({ dates: {} });

  const files = fs.readdirSync(pendingDir).filter(f => f.endsWith('.jpg')).sort();
  const dates = {};

  files.forEach(f => {
    // Format: YYYY-MM-DD_N.jpg
    const match = f.match(/^(\d{4}-\d{2}-\d{2})_(\d)\.jpg$/);
    if (!match) return;
    const [, date, num] = match;
    // { candidates, chosen } object per date — `chosen` used to be set as an
    // expando property on the candidates array, which JSON serialization drops.
    if (!dates[date]) dates[date] = { candidates: [], chosen: null };
    dates[date].candidates.push({
      filename: f,
      number: parseInt(num),
      url: `/chick-growth/pending/${f}`
    });
  });

  // Check which dates already have a chosen frame
  const growthDir = path.join(__dirname, '../../public/chick-growth');
  Object.keys(dates).forEach(date => {
    const chosenPath = path.join(growthDir, `${date}.jpg`);
    dates[date].chosen = fs.existsSync(chosenPath) ? 3 : null;  // default auto-pick is #3
    // Figure out which candidate matches the current chosen frame
    if (fs.existsSync(chosenPath)) {
      const chosenSize = fs.statSync(chosenPath).size;
      const match = dates[date].candidates.find(c => {
        const candidatePath = path.join(pendingDir, c.filename);
        return fs.existsSync(candidatePath) && fs.statSync(candidatePath).size === chosenSize;
      });
      if (match) dates[date].chosen = match.number;
    }
  });

  const backupDir = path.join(pendingDir, 'backup');
  const backupDates = [];
  if (fs.existsSync(backupDir)) {
    const backupFiles = fs.readdirSync(backupDir).filter(f => f.endsWith('.jpg'));
    const seen = new Set();
    backupFiles.forEach(f => {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})_\d\.jpg$/);
      if (m && !seen.has(m[1])) { seen.add(m[1]); backupDates.push(m[1]); }
    });
  }

  res.json({ dates, backupDates });
});

router.post('/admin/chick-growth/pending/:date/choose/:number', requireAdmin, (req, res) => {
  const { date, number } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[1-5]$/.test(number)) {
    return res.status(400).json({ error: 'Invalid date or number' });
  }

  const pendingDir = path.join(__dirname, '../../public/chick-growth/pending');
  const growthDir = path.join(__dirname, '../../public/chick-growth');
  const candidatePath = path.join(pendingDir, `${date}_${number}.jpg`);
  const chosenPath = path.join(growthDir, `${date}.jpg`);

  if (!fs.existsSync(candidatePath)) {
    return res.status(404).json({ error: 'Candidate not found' });
  }

  fs.copyFileSync(candidatePath, chosenPath);

  // Regenerate growth video
  try {
    execSync('/home/ajsornig/chicken-stream/scripts/chick-growth-pick.sh --stitch', { timeout: 30000 });
  } catch (err) {
    console.error('Growth stitch failed:', err.message);
  }

  res.json({ success: true, chosen: parseInt(number) });
});

router.post('/admin/chick-growth/pending/:date/confirm', requireAdmin, (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date' });
  }

  const pendingDir = path.join(__dirname, '../../public/chick-growth/pending');
  const backupDir = path.join(pendingDir, 'backup');

  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  for (let i = 1; i <= 5; i++) {
    const candidatePath = path.join(pendingDir, `${date}_${i}.jpg`);
    if (fs.existsSync(candidatePath)) {
      fs.renameSync(candidatePath, path.join(backupDir, `${date}_${i}.jpg`));
    }
  }

  res.json({ success: true });
});

router.post('/admin/chick-growth/pending/:date/undo', requireAdmin, (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date' });
  }

  const pendingDir = path.join(__dirname, '../../public/chick-growth/pending');
  const backupDir = path.join(pendingDir, 'backup');
  let restored = 0;

  for (let i = 1; i <= 5; i++) {
    const backupPath = path.join(backupDir, `${date}_${i}.jpg`);
    const pendingPath = path.join(pendingDir, `${date}_${i}.jpg`);
    if (fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, pendingPath);
      restored++;
    }
  }

  if (restored === 0) return res.status(404).json({ error: 'No backup found for this date' });
  res.json({ success: true, restored });
});

router.delete('/admin/chick-growth/:filename', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!/^\d{4}-\d{2}-\d{2}\.jpg$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const filepath = path.join(__dirname, '../../public/chick-growth', filename);
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Frame not found' });
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
  // Same store as the admin visitor map, so the public map's pins correspond
  // 1:1 with it — coords are already cell-rounded to ~0.1 deg (~11km) and
  // usernames are dropped so the public map can't identify individual visitors.
  const visitors = Object.values(getVisitedLocations()).map(v => ({
    lat: Math.round(v.lat * 10) / 10,
    lng: Math.round(v.lng * 10) / 10,
    city: v.city,
    country: v.country,
    count: v.count
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
    // NWS station KD95 = Lapeer Dupont-Lapeer (nearest to farm)
    const response = await fetch('https://api.weather.gov/stations/KD95/observations/latest', {
      headers: { 'User-Agent': 'SornigFarm/1.0 (ajsornig@gmail.com)' }
    });
    const data = await response.json();
    const obs = data.properties;

    const tempC = obs.temperature.value;
    const windKmh = obs.windSpeed.value;
    const weather = {
      temp: tempC !== null ? Math.round(tempC * 9 / 5 + 32) : null,
      humidity: obs.relativeHumidity.value !== null ? Math.round(obs.relativeHumidity.value) : null,
      windSpeed: windKmh !== null ? Math.round(windKmh * 0.621371) : null,
      description: obs.textDescription || 'Unknown'
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

// --- Timelapse Analytics ---

router.get('/admin/motion-capture-stats', requireAdmin, (req, res) => {
  const statsLog = path.join(__dirname, '../../logs/motion-capture-stats.log');

  if (!fs.existsSync(statsLog)) {
    return res.json({ days: {} });
  }

  const days = {};
  const lines = fs.readFileSync(statsLog, 'utf8').split('\n').filter(Boolean);

  lines.forEach(line => {
    const parts = line.split('|');
    if (parts.length < 3) return;

    const [date, cam, status] = parts;
    if (!days[date]) days[date] = {};
    if (!days[date][cam]) days[date][cam] = { captured: 0, night: 0, skipped: 0, cooldown: 0, exposure: 0 };
    if (status === 'captured') days[date][cam].captured++;
    else if (status === 'captured_night') days[date][cam].night++;
    else if (status === 'skipped_cooldown') days[date][cam].cooldown++;
    else if (status === 'skipped_exposure') days[date][cam].exposure++;
    else if (status === 'skipped') days[date][cam].skipped++;
  });

  res.json({ days });
});

// --- Infrastructure Dashboard ---

const WIFI_LOG = path.join(__dirname, '../../logs/wifi-monitor.log');
const RESTART_BASELINE_FILE = path.join(__dirname, '../../restart-baseline.json');

function readRestartBaseline() {
  try {
    if (fs.existsSync(RESTART_BASELINE_FILE)) {
      return JSON.parse(fs.readFileSync(RESTART_BASELINE_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Failed to read restart baseline:', err.message);
  }
  return null;
}

router.get('/admin/infra', requireAdmin, (req, res) => {
  try {
    if (!fs.existsSync(WIFI_LOG)) {
      return res.json({ success: true, latest: null, history: [], alerts: [{ level: 'warning', message: 'No monitoring data available' }] });
    }

    const raw = readLogTail(WIFI_LOG);
    const lines = raw.split('\n').filter(Boolean).slice(-INFRA_HISTORY_COUNT);
    const history = lines.map(parseInfraLine).filter(Boolean);
    const latest = history.length > 0 ? history[history.length - 1] : null;
    const camStates = getCamStates(config);
    const alerts = generateInfraAlerts(latest, camStates);

    const cam3Enabled = camStates.some(c => c.id === 'cam3' && c.enabled);

    const baseline = readRestartBaseline();
    if (latest && baseline) {
      latest.restarts = {
        cam1: Math.max(0, latest.restarts.cam1 - (baseline.cam1 || 0)),
        cam2: Math.max(0, latest.restarts.cam2 - (baseline.cam2 || 0)),
        cam3: Math.max(0, latest.restarts.cam3 - (baseline.cam3 || 0))
      };
    }

    res.json({
      success: true, latest, history, alerts, cam3Enabled,
      restartsResetAt: baseline ? baseline.resetAt : null
    });
  } catch (err) {
    console.error('Infra endpoint error:', err);
    res.status(500).json({ error: 'Failed to read infrastructure data' });
  }
});

router.post('/admin/restart-reset', requireAdmin, (req, res) => {
  try {
    const { execSync } = require('child_process');
    const cam1 = parseInt(execSync('sudo systemctl show camera-hls --property=NRestarts', { encoding: 'utf8' }).split('=')[1]) || 0;
    const cam2 = parseInt(execSync('sudo systemctl show camera-hls-2 --property=NRestarts', { encoding: 'utf8' }).split('=')[1]) || 0;
    const cam3 = parseInt(execSync('sudo systemctl show camera-hls-3 --property=NRestarts', { encoding: 'utf8' }).split('=')[1]) || 0;

    const baseline = { cam1, cam2, cam3, resetAt: new Date().toISOString() };
    fs.writeFileSync(RESTART_BASELINE_FILE, JSON.stringify(baseline, null, 2));
    res.json({ success: true, resetAt: baseline.resetAt });
  } catch (err) {
    console.error('Restart reset failed:', err.message);
    res.status(500).json({ error: 'Failed to reset restart counters' });
  }
});

// --- Email Broadcast ---

router.get('/admin/broadcast/recipients', (req, res) => {
  const session = sessionFromRequest(req);
  if (!session || !session.isAdmin) return res.status(403).json({ error: 'Admin only' });

  const users = db.getAllUsers().filter(u => u.email && u.approved);
  res.json(users.map(u => ({ username: u.username, email: u.email, optedOut: !!u.emailOptOut })));
});

router.post('/admin/broadcast', async (req, res) => {
  const session = sessionFromRequest(req);
  if (!session || !session.isAdmin) return res.status(403).json({ error: 'Admin only' });

  const { subject, message } = req.body;
  if (!subject || !message) return res.status(400).json({ error: 'Subject and message required' });
  if (subject.length > 200) return res.status(400).json({ error: 'Subject too long' });
  if (message.length > 5000) return res.status(400).json({ error: 'Message too long' });

  const users = db.getAllUsers().filter(u => u.email && u.approved && !u.emailOptOut);
  const recipients = users.map(u => ({
    username: u.username,
    email: u.email,
    unsubscribeToken: db.getUnsubscribeToken(u.username)
  }));
  const results = await sendBroadcast(subject, message, recipients, config.siteUrl || 'https://sornigfarm.com');
  res.json(results);
});

// --- PTZ Access Management ---

router.post('/admin/users/:username/ptz', (req, res) => {
  const session = sessionFromRequest(req);
  if (!session || !session.isAdmin) return res.status(403).json({ error: 'Admin only' });

  const { enabled, driving } = req.body;
  const result = db.setPtzAccess(req.params.username, enabled, driving);
  if (result.error) return res.status(404).json(result);
  res.json({ success: true, username: req.params.username, ptzAccess: !!enabled, ptzDriving: enabled ? !!driving : false });
});

// --- PTZ Camera Control ---

function requireAuth(req, res, next) {
  const session = sessionFromRequest(req);
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

function requirePtzDriving(req, res, next) {
  if (!db.hasPtzDriving(req.session.username)) {
    return res.status(403).json({ error: 'PTZ driving access not granted' });
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

const ptzDriveLog = new Map();
const PTZ_LOG_COOLDOWN = 5 * 60 * 1000;

router.post('/camera/:id/ptz', requireAuth, requirePtzDriving, ptzLimiter, async (req, res) => {
  const cam = findPtzCamera(req.params.id);
  if (!cam) return res.status(404).json({ error: 'Camera not found or does not support PTZ' });

  const { op, speed } = req.body;
  if (!op || !VALID_OPS.includes(op)) {
    return res.status(400).json({ error: `Invalid op. Valid: ${VALID_OPS.join(', ')}` });
  }

  const logKey = `${req.session.username}:${req.params.id}`;
  const lastLogged = ptzDriveLog.get(logKey) || 0;
  if (Date.now() - lastLogged > PTZ_LOG_COOLDOWN) {
    ptzDriveLog.set(logKey, Date.now());
    db.logActivity(req.session.username, 'ptz_drive', { camera: req.params.id });
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

router.post('/camera/:id/preset/:presetToken/goto', requireAuth, requirePtzAccess, async (req, res) => {
  const cam = findPtzCamera(req.params.id);
  if (!cam) return res.status(404).json({ error: 'Camera not found or does not support PTZ' });

  const { presetToken } = req.params;
  if (!presetToken || presetToken.length > 10) {
    return res.status(400).json({ error: 'Invalid preset token' });
  }

  try {
    const result = await gotoPreset(cam, presetToken);
    db.logActivity(req.session.username, 'ptz_preset', { camera: req.params.id, preset: presetToken });
    res.json(result);
  } catch (err) {
    console.error('Goto preset failed:', err.message);
    res.status(502).json({ error: 'Failed to move to preset' });
  }
});

router.post('/camera/:id/preset', requireAuth, requireAdmin, async (req, res) => {
  const cam = findPtzCamera(req.params.id);
  if (!cam) return res.status(404).json({ error: 'Camera not found or does not support PTZ' });

  const { name } = req.body;
  if (!name || typeof name !== 'string' || name.length > 50) {
    return res.status(400).json({ error: 'Preset name required (max 50 chars)' });
  }

  try {
    const result = await setPreset(cam, name);
    res.json(result);
  } catch (err) {
    console.error('Set preset failed:', err.message);
    res.status(502).json({ error: 'Failed to save preset' });
  }
});

router.delete('/camera/:id/preset/:presetToken', requireAuth, requireAdmin, async (req, res) => {
  const cam = findPtzCamera(req.params.id);
  if (!cam) return res.status(404).json({ error: 'Camera not found or does not support PTZ' });

  const { presetToken } = req.params;
  if (!presetToken || presetToken.length > 10) {
    return res.status(400).json({ error: 'Invalid preset token' });
  }

  try {
    const result = await removePreset(cam, presetToken);
    res.json(result);
  } catch (err) {
    console.error('Remove preset failed:', err.message);
    res.status(502).json({ error: 'Failed to remove preset' });
  }
});

router.get('/camera/:id/tracking', requireAuth, requireAdmin, async (req, res) => {
  const cam = findPtzCamera(req.params.id);
  if (!cam) return res.status(404).json({ error: 'Camera not found or does not support PTZ' });

  try {
    const config = await getAiConfig(cam);
    res.json({
      aiTrack: config.aiTrack === 1,
      trackType: {
        people: config.trackType?.people === 1,
        dogCat: config.trackType?.dog_cat === 1,
        vehicle: config.trackType?.vehicle === 1,
        face: config.trackType?.face === 1
      },
      aiStopBackTime: config.aiStopBackTime,
      aiDisappearBackTime: config.aiDisappearBackTime
    });
  } catch (err) {
    console.error('Get tracking config failed:', err.message);
    res.status(502).json({ error: 'Failed to get tracking config' });
  }
});

router.post('/camera/:id/tracking', requireAuth, requireAdmin, async (req, res) => {
  const cam = findPtzCamera(req.params.id);
  if (!cam) return res.status(404).json({ error: 'Camera not found or does not support PTZ' });

  try {
    const { aiTrack, trackType, aiStopBackTime, aiDisappearBackTime } = req.body;
    if (aiTrack !== undefined) {
      await setAiTrack(cam, aiTrack);
    }
    if (trackType) {
      await setTrackTypes(cam, trackType);
    }
    if (aiStopBackTime !== undefined || aiDisappearBackTime !== undefined) {
      await setTrackBackTimes(cam, { stopBack: aiStopBackTime, disappearBack: aiDisappearBackTime });
    }
    db.logActivity(req.session.username, 'ptz_autotrack', { camera: req.params.id, aiTrack, aiStopBackTime, aiDisappearBackTime });
    res.json({ success: true });
  } catch (err) {
    console.error('Set tracking config failed:', err.message);
    res.status(502).json({ error: 'Failed to update tracking config' });
  }
});

router.get('/camera/:id/guard', requireAuth, requireAdmin, async (req, res) => {
  const cam = findPtzCamera(req.params.id);
  if (!cam) return res.status(404).json({ error: 'Camera not found or does not support PTZ' });

  try {
    const guard = await getPtzGuard(cam);
    res.json({ enable: guard.benable === 1, timeout: guard.timeout });
  } catch (err) {
    console.error('Get guard config failed:', err.message);
    res.status(502).json({ error: 'Failed to get guard config' });
  }
});

router.post('/camera/:id/guard', requireAuth, requireAdmin, async (req, res) => {
  const cam = findPtzCamera(req.params.id);
  if (!cam) return res.status(404).json({ error: 'Camera not found or does not support PTZ' });

  const { enable, timeout } = req.body;
  if (timeout !== undefined && (timeout < 10 || timeout > 300)) {
    return res.status(400).json({ error: 'Timeout must be between 10 and 300 seconds' });
  }

  try {
    await setPtzGuard(cam, { enable, timeout: timeout || 60 });
    res.json({ success: true });
  } catch (err) {
    console.error('Set guard config failed:', err.message);
    res.status(502).json({ error: 'Failed to update guard config' });
  }
});

router.get('/admin/chick-cam-ip', requireAuth, requireAdmin, (req, res) => {
  const cam3 = (config.cameras || []).find(c => c.id === 'cam3');
  if (!cam3) return res.status(404).json({ error: 'cam3 not found in config' });
  if (!cam3.ptz || !cam3.ptz.ip) return res.status(404).json({ error: 'cam3 has no PTZ config' });
  res.json({ success: true, ip: cam3.ptz.ip });
});

router.post('/admin/chick-cam-ip', requireAuth, requireAdmin, (req, res) => {
  const { ip } = req.body;
  if (!ip || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
    return res.status(400).json({ error: 'Invalid IP address' });
  }

  try {
    const scriptPath = path.join(__dirname, '../../scripts/swap-chick-cam-ip.sh');
    const output = execSync(`sudo ${scriptPath} ${ip}`, { timeout: 15000, encoding: 'utf8' });
    const cam3 = config.cameras.find(c => c.id === 'cam3');
    if (cam3 && cam3.ptz) cam3.ptz.ip = ip;
    res.json({ success: true, ip, output });
  } catch (err) {
    console.error('Chick cam IP swap failed:', err.message);
    res.status(500).json({ error: 'Failed to swap IP', details: err.stderr || err.message });
  }
});

module.exports = router;
