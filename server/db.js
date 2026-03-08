const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, '../data.json');

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
  return data;
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createUser(username, password, isAdmin = false) {
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

  data.users[usernameLower] = {
    username: username,
    passwordHash: hashPassword(password),
    isAdmin: isAdmin,
    createdAt: Date.now()
  };
  saveData();
  return { success: true, username };
}

function loginUser(username, password) {
  const usernameLower = username.toLowerCase();
  const user = data.users[usernameLower];
  if (!user || user.passwordHash !== hashPassword(password)) {
    return { error: 'Invalid username or password' };
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
  return data.sessions[token] || null;
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
    isAdmin: u.isAdmin,
    createdAt: u.createdAt
  }));
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

module.exports = {
  initDb,
  createUser,
  loginUser,
  getSession,
  logoutUser,
  getUser,
  getAllUsers,
  deleteUser,
  getRecentMessages,
  saveMessage,
  deleteMessage,
  clearAllMessages,
  pruneOldMessages,
  recordVisit,
  getStats
};
