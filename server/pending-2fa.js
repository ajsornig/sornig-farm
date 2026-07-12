// In-memory store for logins that passed the password check but still owe a
// TOTP code. Deliberately not persisted: a server restart just means the user
// starts the login over. Tokens are returned to the client in the JSON body
// (never a cookie) so they carry no ambient-authority CSRF risk.
const crypto = require('crypto');

const PENDING_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_ENTRIES = 200; // memory backstop; creation rate is IP-rate-limited upstream
const PRUNE_INTERVAL_MS = 60 * 1000;

const pending = new Map(); // token -> { usernameLower, createdAt, attempts }

let nowFn = Date.now;

function create(usernameLower) {
  if (pending.size >= MAX_ENTRIES) {
    const oldest = pending.keys().next().value; // Map preserves insertion order
    pending.delete(oldest);
  }
  const token = crypto.randomBytes(32).toString('hex');
  pending.set(token, { usernameLower, createdAt: nowFn(), attempts: 0 });
  return token;
}

function check(token) {
  if (typeof token !== 'string') return null;
  const entry = pending.get(token);
  if (!entry) return null;
  if (nowFn() - entry.createdAt > PENDING_TTL_MS) {
    pending.delete(token);
    return null;
  }
  return entry;
}

// Call on a wrong code. After MAX_ATTEMPTS failures the entry is destroyed
// and the user must redo the password step.
function recordFailure(token) {
  const entry = check(token);
  if (!entry) return;
  entry.attempts += 1;
  if (entry.attempts >= MAX_ATTEMPTS) {
    pending.delete(token);
  }
}

// Single-use: returns the entry and destroys it, or null if invalid/expired.
function consume(token) {
  const entry = check(token);
  if (!entry) return null;
  pending.delete(token);
  return entry;
}

const pruneTimer = setInterval(() => {
  const cutoff = nowFn() - PENDING_TTL_MS;
  for (const [token, entry] of pending) {
    if (entry.createdAt < cutoff) {
      pending.delete(token);
    }
  }
}, PRUNE_INTERVAL_MS);
pruneTimer.unref();

// Test hooks — not for production use.
function _setNow(fn) {
  nowFn = fn || Date.now;
}
function _clear() {
  pending.clear();
}
function _size() {
  return pending.size;
}

module.exports = {
  create,
  check,
  recordFailure,
  consume,
  PENDING_TTL_MS,
  MAX_ATTEMPTS,
  MAX_ENTRIES,
  _setNow,
  _clear,
  _size,
};
