const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../../config.json');
const db = require('../db');
const { sendApprovalRequest, sendApprovalNotification, sendPasswordResetEmail } = require('../mailer');

const router = express.Router();

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
  res.json(result);
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
    <form id="f"><input type="password" id="p1" placeholder="New password" required minlength="4">
    <input type="password" id="p2" placeholder="Confirm password" required minlength="4">
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
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
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
  res.json({
    loggedIn: true,
    username: session.username,
    isAdmin: session.isAdmin,
    approved: approved,
    requireApproval: config.requireApproval
  });
});

function requireAdmin(req, res, next) {
  const token = req.headers['x-auth-token'];
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

router.get('/status', (req, res) => {
  res.json({
    authEnabled: config.authEnabled,
    requireApproval: config.requireApproval || false,
    cameraCount: config.cameras.filter(c => c.enabled).length,
    recordingEnabled: config.recording.enabled
  });
});

router.get('/stats', (req, res) => {
  res.json(db.getStats());
});

module.exports = router;
