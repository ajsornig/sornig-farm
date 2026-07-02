const config = require('../config.json');
const { getRecentMessages, saveMessage, pruneOldMessages, getSession, clearAllMessages, deleteMessage, recordVisit } = require('./db');
const { filterProfanity } = require('./profanity');
const { isBot, isSuspicious } = require('./botDetect');
const { getClientIp } = require('./security');
const { geolocateIP } = require('./geo');
const { recordVisitedLocation } = require('./visited-locations');

const MAX_CONNECTIONS_PER_IP = 15;

// Expected production host (from SITE_URL) for validating the WS handshake Origin
// without depending on the tunnel preserving the inbound Host header.
let SITE_HOST = null;
try { SITE_HOST = process.env.SITE_URL ? new URL(process.env.SITE_URL).host : null; } catch (e) { /* ignore */ }

// When the real client IP can't be resolved (e.g. cf-connecting-ip missing) the
// socket address is the loopback for every visitor, which would collapse the
// per-IP cap and rate limit onto a single global bucket. Detect that case.
function isLoopback(ip) {
  return !ip || ip === 'unknown' || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

const clients = new Map();
const rateLimits = new Map();        // ip -> timestamp[]
const connectionsByIp = new Map();   // ip -> open connection count
const pendingVisits = new Map();     // Track unverified visitors

// Rate-limit by IP, not by per-connection id. Keying on the connection id let a
// client reset its quota just by reconnecting; keying on IP (and never clearing
// it on disconnect) makes reconnect-flooding ineffective.
function isRateLimited(ip) {
  const { messages, windowSeconds } = config.chat.rateLimit;
  const now = Date.now();
  const windowMs = windowSeconds * 1000;

  const timestamps = (rateLimits.get(ip) || []).filter(t => now - t < windowMs);
  rateLimits.set(ip, timestamps);

  if (timestamps.length >= messages) {
    return true;
  }

  timestamps.push(now);
  return false;
}

// Drop stale IPs from the rate-limit map so it can't grow without bound.
const rateLimitCleanup = setInterval(() => {
  const now = Date.now();
  const windowMs = config.chat.rateLimit.windowSeconds * 1000;
  for (const [ip, times] of rateLimits) {
    if (times.every(t => now - t >= windowMs)) rateLimits.delete(ip);
  }
}, 5 * 60 * 1000);
if (rateLimitCleanup.unref) rateLimitCleanup.unref();

function broadcast(data) {
  const message = JSON.stringify(data);
  for (const [, client] of clients) {
    if (client.ws.readyState === 1) {
      client.ws.send(message);
    }
  }
}

function broadcastViewerCount() {
  let verifiedCount = 0;
  for (const [, client] of clients) {
    if (client.humanVerified) verifiedCount++;
  }
  broadcast({ type: 'viewer_count', count: verifiedCount });
}

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key) out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

// Apply an authenticated session to a connected client (identity, human-verified
// state, visit recording, viewer count) and tell the client. Shared by the
// cookie-on-connect path and the legacy {type:'auth'} message path.
function applyAuthenticatedSession(clientId, ws, session) {
  const client = clients.get(clientId);
  if (!client) return;
  client.nickname = session.username;
  client.isRegistered = true;
  client.isAdmin = session.isAdmin;
  if (!client.humanVerified) {
    client.humanVerified = true;
    broadcastViewerCount();
    const pending = pendingVisits.get(clientId);
    if (pending && !pending.verified) {
      pending.verified = true;
      if (!session.isAdmin) {
        geolocateIP(pending.ip).then(location => {
          recordVisit(location);
          if (location) recordVisitedLocation(session.username, location);
        });
      }
    }
  }
  ws.send(JSON.stringify({ type: 'auth_success', nickname: session.username, isAdmin: session.isAdmin }));
}

function setupChat(wss) {
  wss.on('connection', async (ws, req) => {
    // Reject cross-origin WebSocket handshakes (defense in depth; the session
    // cookie is SameSite=Lax so a cross-site page can't authenticate as the user
    // anyway). Non-browser clients that send no Origin are allowed through.
    const wsOrigin = req.headers.origin;
    if (wsOrigin) {
      let ok = false;
      try {
        const h = new URL(wsOrigin).host;
        ok = h === req.headers.host || (SITE_HOST && h === SITE_HOST);
      } catch (e) { ok = false; }
      if (!ok) { ws.close(1008, 'Bad origin'); return; }
    }

    // Get client IP (check Cloudflare header first, then x-forwarded-for, then direct)
    const ip = getClientIp(req);
    const clientId = Math.random().toString(36).substring(2);
    // Key the cap + rate limit on the real IP, but fall back to the unique
    // connection id when no real IP is available so all clients don't share one
    // global bucket. The real `ip` is still used for geolocation below.
    const rlKey = isLoopback(ip) ? clientId : ip;

    // Cap concurrent connections per IP to blunt connection-flood abuse.
    const openCount = connectionsByIp.get(rlKey) || 0;
    if (openCount >= MAX_CONNECTIONS_PER_IP) {
      ws.close(1008, 'Too many connections');
      return;
    }
    connectionsByIp.set(rlKey, openCount + 1);

    clients.set(clientId, { ws, ip, rlKey, nickname: null, isRegistered: false, isAdmin: false, humanVerified: false });

    const userAgent = req.headers['user-agent'] || '';

    // Check if this looks like a bot
    const looksLikeBot = isBot(userAgent) || isSuspicious(req);

    if (!looksLikeBot) {
      // Store pending visit - will be confirmed when user interacts
      pendingVisits.set(clientId, { ip, verified: false });
    } else {
      console.log(`Bot detected: ${userAgent.substring(0, 50)}...`);
    }

    const recentMessages = getRecentMessages(config.chat.maxMessages);
    ws.send(JSON.stringify({ type: 'history', messages: recentMessages }));

    // Broadcast updated viewer count
    broadcastViewerCount();

    // Authenticate from the httpOnly session cookie sent on the handshake — the
    // client no longer holds a token in JS to send in an auth message.
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.sf_session) {
      const cookieSession = getSession(cookies.sf_session);
      if (cookieSession) applyAuthenticatedSession(clientId, ws, cookieSession);
    }

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const client = clients.get(clientId);

        if (msg.type === 'auth') {
          // Legacy path for any client still sending a token; the cookie handled
          // on connect is the primary route now.
          const session = getSession(msg.token);
          if (session) {
            applyAuthenticatedSession(clientId, ws, session);
          } else {
            ws.send(JSON.stringify({ type: 'auth_failed' }));
          }
          return;
        }

        // Human verification - triggered by user interaction (for viewer count only)
        if (msg.type === 'verify_human') {
          if (!client.humanVerified) {
            client.humanVerified = true;
            broadcastViewerCount();
          }
          return;
        }

        if (msg.type === 'set_nickname') {
          const nickname = sanitize(msg.nickname).substring(0, 20);
          if (nickname.length >= 2) {
            client.nickname = nickname;
            client.isRegistered = false;
            client.isAdmin = false;
            ws.send(JSON.stringify({ type: 'nickname_set', nickname }));
          } else {
            ws.send(JSON.stringify({ type: 'error', message: 'Nickname must be at least 2 characters' }));
          }
          return;
        }

        if (msg.type === 'chat') {
          if (!client.nickname) {
            ws.send(JSON.stringify({ type: 'error', message: 'Set a nickname first' }));
            return;
          }

          if (isRateLimited(client.rlKey)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Slow down! Too many messages.' }));
            return;
          }

          let content = sanitize(msg.content).substring(0, 500);
          if (content.length === 0) return;

          // Filter profanity
          content = filterProfanity(content);

          const saved = saveMessage(client.nickname, content, client.isRegistered);
          broadcast({ type: 'chat', ...saved });

          pruneOldMessages();
        }

        if (msg.type === 'admin_clear_chat') {
          if (!client.isAdmin) {
            ws.send(JSON.stringify({ type: 'error', message: 'Admin access required' }));
            return;
          }
          clearAllMessages();
          broadcast({ type: 'chat_cleared' });
        }

        if (msg.type === 'admin_delete_message') {
          if (!client.isAdmin) {
            ws.send(JSON.stringify({ type: 'error', message: 'Admin access required' }));
            return;
          }
          if (deleteMessage(msg.messageId)) {
            broadcast({ type: 'message_deleted', messageId: msg.messageId });
          }
        }

      } catch (err) {
        console.error('Chat message error:', err);
      }
    });

    ws.on('close', () => {
      clients.delete(clientId);
      pendingVisits.delete(clientId);
      const remaining = (connectionsByIp.get(rlKey) || 1) - 1;
      if (remaining <= 0) connectionsByIp.delete(rlKey);
      else connectionsByIp.set(rlKey, remaining);
      // Note: rateLimits is intentionally NOT cleared here so reconnecting
      // cannot reset a client's message quota.
      broadcastViewerCount();
    });
  });
}

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .trim();
}

module.exports = { setupChat, broadcast };
