const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJSON } = require('./atomic-write');
const { removeUserAttribution } = require('./visited-locations');
const totp = require('./totp');

const DATA_FILE = path.join(__dirname, '../data.json');
const ACTIVITY_LOG_FILE = path.join(__dirname, '../logs/activity.json');
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
const TRUSTED_DEVICE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days ("remember this device")
const ACTIVITY_MAX_ENTRIES = 200;
const MIN_PASSWORD_LENGTH = 8;
// Usernames are interpolated into HTML/JS on the admin panel, so restrict them
// to a safe character set at creation time (defense in depth on top of output
// escaping). Email is validated wherever it can be set. This is the single
// source of truth for the rule — the register route imports it too.
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,20}$/;
// Restrictive on purpose: forbids quotes/backticks/angle brackets so an email can
// never carry an HTML/JS payload even before output escaping.
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

let data = {
  messages: [],
  users: {},
  sessions: {},
  stats: {
    totalViews: 0,
    visitors: []
  },
  pushSubscriptions: []
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
        stats: loaded.stats || { totalViews: 0, visitors: [] },
        favorites: loaded.favorites || [],
        // Explicitly whitelisted: keys absent here are silently dropped on the
        // next save, which for subscriptions would mean push dying on restart.
        pushSubscriptions: loaded.pushSubscriptions || []
      };
    } catch (err) {
      console.error('Failed to load data file, starting fresh:', err.message);
      data = { messages: [], users: {}, sessions: {}, stats: { totalViews: 0, visitors: [] }, favorites: [], pushSubscriptions: [] };
    }
  }
  // One-time cleanup: the per-visit stats.visitors array is dead (the visitor map
  // moved to visited-locations.js); drop any historical entries so they stop
  // bloating every data.json write. totalViews is preserved.
  if (data.stats && Array.isArray(data.stats.visitors) && data.stats.visitors.length) {
    data.stats.visitors = [];
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

// Coalesce data.json writes. Callers used to trigger a full atomic rewrite of the
// entire file on EVERY mutation (login, /me, each chat message, favorites, session
// prune) — the top SD-card write-amplification source on the Pi. Now a write just
// marks the data dirty and schedules a single flush; bursts of rapid mutations
// collapse into one disk write. Worst-case data-loss window on an unclean power
// loss is FLUSH_INTERVAL_MS; a graceful shutdown (the deploy's `kill` = SIGTERM)
// flushes synchronously via flushDataSync(), so ordinary restarts lose nothing.
const FLUSH_INTERVAL_MS = 3000;
let dataDirty = false;
let flushTimer = null;

function saveData() {
  dataDirty = true;
  if (!flushTimer) {
    flushTimer = setTimeout(flushDataIfDirty, FLUSH_INTERVAL_MS);
    if (flushTimer.unref) flushTimer.unref();
  }
}

function flushDataIfDirty() {
  flushTimer = null;
  if (!dataDirty) return;
  try {
    atomicWriteJSON(DATA_FILE, data);
    dataDirty = false;
  } catch (err) {
    // Keep it dirty and retry on the next tick rather than losing the write.
    console.error('data.json flush failed, will retry:', err.message);
    flushTimer = setTimeout(flushDataIfDirty, FLUSH_INTERVAL_MS);
    if (flushTimer.unref) flushTimer.unref();
  }
}

// Flush pending data synchronously — call from a graceful-shutdown handler so a
// restart never drops the last few seconds of writes.
function flushDataSync() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (dataDirty) {
    atomicWriteJSON(DATA_FILE, data);
    dataDirty = false;
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

// Constant-time compare of two hex-encoded digests (equal length required).
function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  if (stored.startsWith('scrypt:')) {
    const [, salt, hash] = stored.split(':');
    if (!salt || !hash) return false;
    const derived = crypto.scryptSync(password, salt, 64).toString('hex');
    return timingSafeEqualHex(derived, hash);
  }
  // Legacy SHA-256 (no salt, 64-char hex)
  const derived = crypto.createHash('sha256').update(password).digest('hex');
  return timingSafeEqualHex(derived, stored);
}

function isLegacyHash(stored) {
  return !stored.startsWith('scrypt:');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createUser(username, password, isAdmin = false, email = null) {
  if (typeof username !== 'string' || typeof password !== 'string') {
    return { error: 'Invalid username or password' };
  }
  const usernameLower = username.toLowerCase();
  if (data.users[usernameLower]) {
    return { error: 'Username already exists' };
  }
  if (!USERNAME_RE.test(username)) {
    return { error: 'Username must be 3-20 characters: letters, numbers, and . _ - only' };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  if (email && !EMAIL_RE.test(email)) {
    return { error: 'Please enter a valid email address' };
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

// Password check WITHOUT session creation — the login route needs to hold the
// session back until a 2FA-enrolled admin has also presented a TOTP code.
function verifyCredentials(username, password) {
  const usernameLower = username.toLowerCase();
  const user = data.users[usernameLower];
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return { error: 'Invalid username or password' };
  }

  // Auto-migrate legacy SHA-256 hashes to scrypt
  if (isLegacyHash(user.passwordHash)) {
    user.passwordHash = hashPassword(password);
    saveData();
  }
  return { success: true, user };
}

function createSession(username) {
  const user = data.users[username.toLowerCase()];
  if (!user) return null;
  const token = generateToken();
  data.sessions[token] = {
    username: user.username,
    isAdmin: user.isAdmin,
    createdAt: Date.now()
  };
  saveData();
  return { token, username: user.username, isAdmin: user.isAdmin };
}

function loginUser(username, password) {
  const cred = verifyCredentials(username, password);
  if (cred.error) return cred;
  const session = createSession(username);
  return { success: true, ...session };
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
    ptzAccess: u.ptzAccess || false,
    ptzDriving: u.ptzDriving || false,
    createdAt: u.createdAt
  }));
}

function hasPtzAccess(username) {
  const user = data.users[username.toLowerCase()];
  if (!user) return false;
  return user.isAdmin || user.ptzAccess === true;
}

function hasPtzDriving(username) {
  const user = data.users[username.toLowerCase()];
  if (!user) return false;
  return user.isAdmin || (user.ptzAccess === true && user.ptzDriving === true);
}

function setPtzAccess(username, enabled, driving) {
  const usernameLower = username.toLowerCase();
  if (!data.users[usernameLower]) return { error: 'User not found' };
  data.users[usernameLower].ptzAccess = !!enabled;
  data.users[usernameLower].ptzDriving = enabled ? !!driving : false;
  saveData();
  return { success: true };
}

function updateUserEmail(username, email) {
  const usernameLower = username.toLowerCase();
  if (!data.users[usernameLower]) {
    return { error: 'User not found' };
  }
  if (email && !EMAIL_RE.test(email)) {
    return { error: 'Please enter a valid email address' };
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
    sweepVisitorMapAttribution(username);
    return true;
  }
  return false;
}

// Privacy: a deleted/denied user's name must not linger on the admin visitor
// map. Best-effort — the failure is logged, but a map-write error must never
// block the account deletion itself.
function sweepVisitorMapAttribution(username) {
  try {
    removeUserAttribution(username);
  } catch (err) {
    console.error('Visitor-map sweep failed for ' + username + ':', err);
  }
}

function resetPassword(username, newPassword) {
  const usernameLower = username.toLowerCase();
  if (!data.users[usernameLower]) {
    return { error: 'User not found' };
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  data.users[usernameLower].passwordHash = hashPassword(newPassword);
  delete data.users[usernameLower].resetToken;
  delete data.users[usernameLower].resetTokenExpiry;
  // A password reset must also revoke remembered 2FA devices — otherwise a
  // stolen sf_trust cookie would survive the rotation.
  delete data.users[usernameLower].trustedDevices;
  Object.keys(data.sessions).forEach(token => {
    if (data.sessions[token].username.toLowerCase() === usernameLower) {
      delete data.sessions[token];
    }
  });
  saveData();
  return { success: true };
}

function changePassword(username, currentPassword, newPassword, keepToken = null) {
  const usernameLower = username.toLowerCase();
  const user = data.users[usernameLower];
  if (!user) {
    return { error: 'User not found' };
  }
  if (!verifyPassword(currentPassword, user.passwordHash)) {
    return { error: 'Current password is incorrect' };
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return { error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  user.passwordHash = hashPassword(newPassword);
  // A password change revokes the user's OTHER sessions (log out any other
  // devices), but keeps the caller's current session so they stay logged in here.
  // Remembered 2FA devices are revoked too — a rotation must invalidate any
  // stolen sf_trust cookie.
  delete user.trustedDevices;
  Object.keys(data.sessions).forEach(token => {
    if (token !== keepToken && data.sessions[token].username.toLowerCase() === usernameLower) {
      delete data.sessions[token];
    }
  });
  saveData();
  return { success: true };
}

// ===== Two-factor auth (TOTP) — admin accounts only by policy (enforced at
// the route layer; the data layer is user-agnostic) =====

function beginTotpSetup(username) {
  const usernameLower = username.toLowerCase();
  const user = data.users[usernameLower];
  if (!user) return { error: 'User not found' };
  const secret = totp.generateSecret();
  data.users[usernameLower] = { ...user, totpPendingSecret: secret };
  saveData();
  return {
    success: true,
    secret,
    otpauth: totp.otpauthURI('Sornig Farm', user.username, secret)
  };
}

// Flips 2FA on only after the user proves their authenticator produces a valid
// code for the pending secret — a botched QR scan can never lock anyone out.
// Revokes the user's OTHER sessions (keepToken survives) like changePassword.
function confirmTotpSetup(username, code, keepToken = null) {
  const usernameLower = username.toLowerCase();
  const user = data.users[usernameLower];
  if (!user) return { error: 'User not found' };
  if (!user.totpPendingSecret) return { error: 'No 2FA setup in progress' };
  const result = totp.verifyTotp(user.totpPendingSecret, code);
  if (!result.ok) {
    return { error: 'Code did not match. Check your authenticator app and try again.' };
  }
  const { codes, hashes } = totp.generateBackupCodes();
  const updated = {
    ...user,
    totpSecret: user.totpPendingSecret,
    totpEnabled: true,
    totpLastUsedStep: result.step,
    backupCodes: hashes,
    trustedDevices: {}
  };
  delete updated.totpPendingSecret;
  data.users[usernameLower] = updated;
  Object.keys(data.sessions).forEach(token => {
    if (token !== keepToken && data.sessions[token].username.toLowerCase() === usernameLower) {
      delete data.sessions[token];
    }
  });
  saveData();
  return { success: true, backupCodes: codes };
}

function disableTotp(username) {
  const usernameLower = username.toLowerCase();
  const user = data.users[usernameLower];
  if (!user) return { error: 'User not found' };
  const cleaned = { ...user };
  ['totpSecret', 'totpEnabled', 'totpPendingSecret', 'totpLastUsedStep', 'backupCodes', 'trustedDevices']
    .forEach(k => delete cleaned[k]);
  data.users[usernameLower] = cleaned;
  saveData();
  return { success: true };
}

// Verifies a 6-digit TOTP code (persisting the used step for replay
// protection) or consumes a single-use backup code. Longer-than-6 input is
// treated as a backup code.
function verifyAndConsumeTotp(username, code) {
  const usernameLower = username.toLowerCase();
  const user = data.users[usernameLower];
  if (!user || !user.totpEnabled || !user.totpSecret) {
    return { error: 'Two-factor authentication is not enabled' };
  }
  const normalized = String(code || '').replace(/\s/g, '');
  if (/^\d{6}$/.test(normalized)) {
    const result = totp.verifyTotp(user.totpSecret, normalized, {
      lastUsedStep: user.totpLastUsedStep || 0
    });
    if (!result.ok) return { error: 'Invalid code' };
    data.users[usernameLower] = { ...user, totpLastUsedStep: result.step };
    saveData();
    return { success: true, method: 'totp' };
  }
  // Backup-code path: compare against every stored hash (no early exit).
  const hash = totp.hashBackupCode(normalized);
  const stored = Array.isArray(user.backupCodes) ? user.backupCodes : [];
  let matchIndex = -1;
  for (let i = 0; i < stored.length; i++) {
    if (timingSafeEqualHex(hash, stored[i])) matchIndex = i;
  }
  if (matchIndex === -1) return { error: 'Invalid code' };
  data.users[usernameLower] = {
    ...user,
    backupCodes: stored.filter((_, i) => i !== matchIndex)
  };
  saveData();
  return { success: true, method: 'backup', backupCodesRemaining: stored.length - 1 };
}

// ===== Trusted devices ("remember this device for 30 days") — only the
// sha256 of the cookie token is stored at rest =====

function hashTrustToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}

function pruneTrustedDevices(user) {
  const devices = user.trustedDevices || {};
  const now = Date.now();
  const kept = {};
  let changed = false;
  for (const [tokenHash, info] of Object.entries(devices)) {
    if (info && now - info.createdAt <= TRUSTED_DEVICE_MAX_AGE) {
      kept[tokenHash] = info;
    } else {
      changed = true;
    }
  }
  return { kept, changed };
}

function addTrustedDevice(username, rawToken) {
  const usernameLower = username.toLowerCase();
  const user = data.users[usernameLower];
  if (!user) return { error: 'User not found' };
  const { kept } = pruneTrustedDevices(user);
  kept[hashTrustToken(rawToken)] = { createdAt: Date.now() };
  data.users[usernameLower] = { ...user, trustedDevices: kept };
  saveData();
  return { success: true };
}

function isTrustedDevice(username, rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return false;
  const usernameLower = username.toLowerCase();
  const user = data.users[usernameLower];
  if (!user || !user.trustedDevices) return false;
  const { kept, changed } = pruneTrustedDevices(user);
  if (changed) {
    data.users[usernameLower] = { ...user, trustedDevices: kept };
    saveData();
  }
  return Boolean(kept[hashTrustToken(rawToken)]);
}

function get2faStatus(username) {
  const user = data.users[username.toLowerCase()];
  if (!user) return { error: 'User not found' };
  return {
    enabled: !!user.totpEnabled,
    pending: !!user.totpPendingSecret,
    backupCodesRemaining: Array.isArray(user.backupCodes) ? user.backupCodes.length : 0,
    trustedDeviceCount: user.trustedDevices ? Object.keys(user.trustedDevices).length : 0
  };
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
  sweepVisitorMapAttribution(username);
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
  // Visitor pins now live in visited-locations.js; here we only keep the running
  // total. (The old per-visit stats.visitors array is dead — nothing reads it —
  // and dropping it shrinks every data.json write.)
  data.stats.totalViews++;
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
  atomicWriteJSON(ACTIVITY_LOG_FILE, log);
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

function deleteActivityEntry(timestamp, username) {
  // Match by timestamp+username instead of list index: new activity is logged
  // constantly, so an index captured by the admin page goes stale immediately.
  const log = loadActivityLog();
  const index = log.findIndex(e => e.timestamp === timestamp && e.username === username);
  if (index === -1) return false;
  log.splice(index, 1);
  saveActivityLog(log);
  return true;
}

function clearActivityLog() {
  saveActivityLog([]);
}

function setEmailOptOut(username, optOut) {
  const usernameLower = username.toLowerCase();
  const user = data.users[usernameLower];
  if (!user) return { error: 'User not found' };
  data.users[usernameLower] = { ...user, emailOptOut: !!optOut };
  saveData();
  return { success: true };
}

function getUnsubscribeToken(username) {
  const usernameLower = username.toLowerCase();
  const user = data.users[usernameLower];
  if (!user) return null;
  if (!user.unsubscribeToken) {
    data.users[usernameLower] = { ...user, unsubscribeToken: generateToken() };
    saveData();
  }
  return data.users[usernameLower].unsubscribeToken;
}

function getUserByUnsubscribeToken(token) {
  for (const user of Object.values(data.users)) {
    if (user.unsubscribeToken === token) return user;
  }
  return null;
}

// ===== Web-push subscriptions (admin phone alerts) =====

function getPushSubscriptions() {
  if (!data.pushSubscriptions) data.pushSubscriptions = [];
  return data.pushSubscriptions;
}

// Upsert keyed on endpoint: re-subscribing from the same browser replaces the
// old entry instead of stacking duplicates.
function addPushSubscription({ endpoint, keys, username, ua }) {
  if (!data.pushSubscriptions) data.pushSubscriptions = [];
  data.pushSubscriptions = [
    ...data.pushSubscriptions.filter(s => s.endpoint !== endpoint),
    {
      endpoint,
      keys,
      username,
      ua: ua ? String(ua).slice(0, 120) : null,
      createdAt: Date.now()
    }
  ];
  saveData();
  return { success: true };
}

function removePushSubscription(endpoint) {
  if (!data.pushSubscriptions) return false;
  const before = data.pushSubscriptions.length;
  data.pushSubscriptions = data.pushSubscriptions.filter(s => s.endpoint !== endpoint);
  if (data.pushSubscriptions.length === before) return false;
  saveData();
  return true;
}

function getFavorites() {
  if (!data.favorites) data.favorites = [];
  return [...data.favorites].sort((a, b) => b.starred - a.starred);
}

function addFavorite(filename, cam) {
  if (!data.favorites) data.favorites = [];
  if (data.favorites.some(f => f.filename === filename)) return false;
  data.favorites = [...data.favorites, { filename, cam, starred: Date.now() }];
  saveData();
  return true;
}

function removeFavorite(filename) {
  if (!data.favorites) return false;
  const before = data.favorites.length;
  data.favorites = data.favorites.filter(f => f.filename !== filename);
  if (data.favorites.length === before) return false;
  saveData();
  return true;
}

module.exports = {
  USERNAME_RE,
  hashPassword,
  verifyPassword,
  initDb,
  flushDataSync,
  createUser,
  loginUser,
  verifyCredentials,
  createSession,
  beginTotpSetup,
  confirmTotpSetup,
  disableTotp,
  verifyAndConsumeTotp,
  addTrustedDevice,
  isTrustedDevice,
  get2faStatus,
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
  getActivityLog,
  deleteActivityEntry,
  clearActivityLog,
  hasPtzAccess,
  hasPtzDriving,
  setPtzAccess,
  setEmailOptOut,
  getUnsubscribeToken,
  getUserByUnsubscribeToken,
  getFavorites,
  addFavorite,
  removeFavorite,
  getPushSubscriptions,
  addPushSubscription,
  removePushSubscription
};
