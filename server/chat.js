const config = require('../config.json');
const { getRecentMessages, saveMessage, pruneOldMessages, getSession, clearAllMessages, deleteMessage, recordVisit } = require('./db');
const { filterProfanity } = require('./profanity');
const { isBot, isSuspicious } = require('./botDetect');
const { getClientIp } = require('./security');
const { geolocateIP } = require('./geo');

const MAX_CONNECTIONS_PER_IP = 15;

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

function setupChat(wss) {
  wss.on('connection', async (ws, req) => {
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

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const client = clients.get(clientId);

        if (msg.type === 'auth') {
          const session = getSession(msg.token);
          if (session) {
            client.nickname = session.username;
            client.isRegistered = true;
            client.isAdmin = session.isAdmin;
            // Logged-in users are automatically verified as human
            if (!client.humanVerified) {
              client.humanVerified = true;
              broadcastViewerCount();

              // Record visit for map (skip admins)
              const pending = pendingVisits.get(clientId);
              if (pending && !pending.verified) {
                pending.verified = true;
                if (!session.isAdmin) {
                  geolocateIP(pending.ip).then(location => {
                    recordVisit(location);
                    console.log(`Verified logged-in visitor from ${location?.city || 'unknown'}`);
                  });
                }
              }
            }
            ws.send(JSON.stringify({
              type: 'auth_success',
              nickname: session.username,
              isAdmin: session.isAdmin
            }));
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
