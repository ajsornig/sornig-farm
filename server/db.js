const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, '../data.json');
const ACTIVITY_LOG_FILE = path.join(__dirname, '../logs/activity.json');
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
const ACTIVITY_MAX_ENTRIES = 200;

let data = {
  messages: [],
  users: {},
  sessions: {},
  stats: {
    totalViews: 0,
    visitors: []
  }
};

function initDb() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const content = fs.readFileSync(DATA_FILE, 'utf-8');
      const loaded = JSON.parse(content);
      data = {
        messages: loaded.messages || [],
        users: loaded.users || {},
        sessions: loaded.sessions || {},
        stats: loaded.stats || { totalViews: 0, visitors: [] }
      };
    } catch (err) {
      console.error('Failed to load data file, starting fresh:', err.message);
      data = { messages: [], users: {}, sessions: {}, stats: { totalViews: 0, visitors: [] } };
    }
  }
  pruneExpiredSessions();
  return data;
}

function pruneExpiredSessions() {
  const now = Date.now();
  let pruned = false;
  for (const token of Object.keys(data.sessions)) {
    if (now - data.sessions[token].createdAt > SESSION_MAX_AGE) {
      delete data.sessions[token];
      pruned = true;
    }
  }
  if (pruned) saveData();
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (stored.startsWith('scrypt:')) {
    const [, salt, hash] = stored.split(':');
    const derived = crypto.scryptSync(password, salt, 64).toString('hex');
    return derived === hash;
  }
  // Legacy SHA-256 (no salt, 64-char hex)
  return crypto.createHash('sha256').update(password).digest('hex') === stored;
}

function isLegacyHash(stored) {
  return !stored.startsWith('scrypt:');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createUser(username, password, isAdmin = false, email = null) {
  const usernameLower = username.toLowerCase();
  if (data.users[usernameLower]) {
    return { error: 'Username already exists' };
  }
  if (username.length < 2 || username.length > 20) {
    return { error: 'Username must be 2-20 characters' };
  }
  if (password.length < 4) {
    return { error: 'Password must be at least 4 characters' };
  }

  const approvalToken = generateToken();
  data.users[usernameLower] = {
    username: username,
    passwordHash: hashPassword(password),
    email: email,
    isAdmin: isAdmin,
    approved: isAdmin, // Admins are auto-approved
    approvalToken: approvalToken,
    createdAt: Date.now()
  };
  saveData();
  return { success: true, username, approvalToken, needsApproval: !isAdmin };
}

function loginUser(username, password) {
  const usernameLower = username.toLowerCase();
  const user = data.users[usernameLower];
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return { error: 'Invalid username or password' };
  }

  // Auto-migrate legacy SHA-256 hashes to scrypt
  if (isLegacyHash(user.passwordHash)) {
    user.passwordHash = hashPassword(password);
  }

  const token = generateToken();
  data.sessions[token] = {
    username: user.username,
    isAdmin: user.isAdmin,
    createdAt: Date.now()
  };
  saveData();
  return { success: true, token, username: user.username, isAdmin: user.isAdmin };
}

function getSession(token) {
  const session = data.sessions[token];
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_MAX_AGE) {
    delete data.sessions[token];
    saveData();
    return null;
  }
  return session;
}

function logoutUser(token) {
  if (data.sessions[token]) {
    delete data.sessions[token];
    saveData();
    return true;
  }
  return false;
}

function getUser(username) {
  return data.users[username.toLowerCase()] || null;
}

function getAllUsers() {
  return Object.values(data.users).map(u => ({
    username: u.username,
    email: u.email || null,
    isAdmin: u.isAdmin,
    approved: u.approved !== false,
    createdAt: u.createdAt
  }));
}

function updateUserEmail(username, email) {
  const usernameLower = username.toLowerCase();
  if (!data.users[usernameLower]) {
    return { error: 'User not found' };
  }
  data.users[usernameLower].email = email || null;
  saveData();
  return { success: true };
}

function deleteUser(username) {
  const usernameLower = username.toLowerCase();
  if (data.users[usernameLower]) {
    delete data.users[usernameLower];
    Object.keys(data.sessions).forEach(token => {
      if (data.sessions[token].username.toLowerCase() === usernameLower) {
        delete data.sessions[token];
      }
    });
    saveData();
    return true;
  }
  return false;
}

function resetPassword(username, newPassword) {
  const usernameLower = username.toLowerCase();
  if (!data.users[usernameLower]) {
    return { error: 'User not found' };
  }
  if (newPassword.length < 4) {
    return { error: 'Password must be at least 4 characters' };
  }
  data.users[usernameLower].passwordHash = hashPassword(newPassword);
  delete data.users[usernameLower].resetToken;
  delete data.users[usernameLower].resetTokenExpiry;
  Object.keys(data.sessions).forEach(token => {
    if (data.sessions[token].username.toLowerCase() === usernameLower) {
      delete data.sessions[token];
    }
  });
  saveData();
  return { success: true };
}

function changePassword(username, currentPassword, newPassword) {
  const usernameLower = username.toLowerCase();
  const user = data.users[usernameLower];
  if (!user) {
    return { error: 'User not found' };
  }
  if (!verifyPassword(currentPassword, user.passwordHash)) {
    return { error: 'Current password is incorrect' };
  }
  if (newPassword.length < 4) {
    return { error: 'New password must be at least 4 characters' };
  }
  user.passwordHash = hashPassword(newPassword);
  saveData();
  return { success: true };
}

function createResetToken(email) {
  const user = Object.values(data.users).find(u => u.email && u.email.toLowerCase() === email.toLowerCase());
  if (!user) {
    return { error: 'No account found with that email' };
  }
  const token = generateToken();
  const usernameLower = user.username.toLowerCase();
  data.users[usernameLower].resetToken = token;
  data.users[usernameLower].resetTokenExpiry = Date.now() + 3600000; // 1 hour
  saveData();
  return { success: true, token, username: user.username };
}

function getUserByResetToken(token) {
  const user = Object.values(data.users).find(u => u.resetToken === token && u.resetTokenExpiry > Date.now());
  return user || null;
}

function getPendingUsers() {
  return Object.values(data.users)
    .filter(u => !u.approved && !u.isAdmin)
    .map(u => ({
      username: u.username,
      email: u.email,
      createdAt: u.createdAt
    }));
}

function approveUser(username) {
  const usernameLower = username.toLowerCase();
  if (!data.users[usernameLower]) {
    return { error: 'User not found' };
  }
  data.users[usernameLower].approved = true;
  saveData();
  return { success: true, email: data.users[usernameLower].email };
}

function denyUser(username) {
  const usernameLower = username.toLowerCase();
  if (!data.users[usernameLower]) {
    return { error: 'User not found' };
  }
  const email = data.users[usernameLower].email;
  delete data.users[usernameLower];
  // Also delete any sessions
  Object.keys(data.sessions).forEach(token => {
    if (data.sessions[token].username.toLowerCase() === usernameLower) {
      delete data.sessions[token];
    }
  });
  saveData();
  return { success: true, email };
}

function getUserByApprovalToken(token) {
  return Object.values(data.users).find(u => u.approvalToken === token) || null;
}

function isUserApproved(username) {
  const user = data.users[username.toLowerCase()];
  if (!user) return false;
  // Existing users without approved field and admins are considered approved
  if (user.approved === undefined || user.isAdmin) return true;
  return user.approved;
}

function getRecentMessages(limit = 50) {
  return data.messages.slice(-limit);
}

function saveMessage(nickname, content, isRegistered = false) {
  const timestamp = Date.now();
  const id = crypto.randomBytes(8).toString('hex');
  const message = { id, nickname, content, timestamp, isRegistered };
  data.messages.push(message);
  saveData();
  return message;
}

function deleteMessage(messageId) {
  const index = data.messages.findIndex(m => m.id === messageId);
  if (index !== -1) {
    data.messages.splice(index, 1);
    saveData();
    return true;
  }
  return false;
}

function clearAllMessages() {
  data.messages = [];
  saveData();
  return true;
}

function pruneOldMessages(maxMessages = 500) {
  if (data.messages.length > maxMessages) {
    data.messages = data.messages.slice(-maxMessages);
    saveData();
  }
}

function recordVisit(location) {
  data.stats.totalViews++;
  if (location && location.lat && location.lng) {
    data.stats.visitors.push({
      lat: location.lat,
      lng: location.lng,
      city: location.city || 'Unknown',
      country: location.country || 'Unknown',
      timestamp: Date.now()
    });
    // Keep only last 1000 visitor locations
    if (data.stats.visitors.length > 1000) {
      data.stats.visitors = data.stats.visitors.slice(-1000);
    }
  }
  saveData();
}

function getStats() {
  return {
    totalViews: data.stats.totalViews,
    visitors: data.stats.visitors
  };
}

function loadActivityLog() {
  if (fs.existsSync(ACTIVITY_LOG_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(ACTIVITY_LOG_FILE, 'utf-8'));
    } catch (err) {
      return [];
    }
  }
  return [];
}

function saveActivityLog(log) {
  const dir = path.dirname(ACTIVITY_LOG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(ACTIVITY_LOG_FILE, JSON.stringify(log, null, 2));
}

function logActivity(username, action, details = null) {
  const log = loadActivityLog();
  log.push({
    timestamp: Date.now(),
    username,
    action,
    details
  });
  // Keep only the most recent entries
  const trimmed = log.slice(-ACTIVITY_MAX_ENTRIES);
  saveActivityLog(trimmed);
}

function getActivityLog() {
  return loadActivityLog().reverse();
}

module.exports = {
  initDb,
  createUser,
  loginUser,
  getSession,
  logoutUser,
  getUser,
  getAllUsers,
  deleteUser,
  resetPassword,
  changePassword,
  createResetToken,
  getUserByResetToken,
  updateUserEmail,
  getPendingUsers,
  approveUser,
  denyUser,
  getUserByApprovalToken,
  isUserApproved,
  getRecentMessages,
  saveMessage,
  deleteMessage,
  clearAllMessages,
  pruneOldMessages,
  recordVisit,
  getStats,
  logActivity,
  getActivityLog
};
