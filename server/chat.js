const config = require('../config.json');
const { getRecentMessages, saveMessage, pruneOldMessages, getSession, clearAllMessages, deleteMessage, recordVisit } = require('./db');
const { filterProfanity } = require('./profanity');
const { isBot, isSuspicious } = require('./botDetect');

async function geolocateIP(ip) {
  // Skip localhost/private IPs
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
    return null;
  }

  try {
    const response = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,city,lat,lon`);
    const data = await response.json();
    if (data.status === 'success') {
      return {
        city: data.city,
        country: data.country,
        lat: data.lat,
        lng: data.lon
      };
    }
  } catch (err) {
    console.error('Geolocation failed:', err.message);
  }
  return null;
}

const clients = new Map();
const rateLimits = new Map();
const pendingVisits = new Map(); // Track unverified visitors

function isRateLimited(clientId) {
  const { messages, windowSeconds } = config.chat.rateLimit;
  const now = Date.now();
  const windowMs = windowSeconds * 1000;

  if (!rateLimits.has(clientId)) {
    rateLimits.set(clientId, []);
  }

  const timestamps = rateLimits.get(clientId).filter(t => now - t < windowMs);
  rateLimits.set(clientId, timestamps);

  if (timestamps.length >= messages) {
    return true;
  }

  timestamps.push(now);
  return false;
}

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
    const clientId = Math.random().toString(36).substring(2);
    clients.set(clientId, { ws, nickname: null, isRegistered: false, isAdmin: false, humanVerified: false });

    // Get client IP (check Cloudflare header first, then x-forwarded-for, then direct)
    const ip = req.headers['cf-connecting-ip'] ||
               req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
               req.socket.remoteAddress;

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

              // Record visit for map
              const pending = pendingVisits.get(clientId);
              if (pending && !pending.verified) {
                pending.verified = true;
                geolocateIP(pending.ip).then(location => {
                  recordVisit(location);
                  console.log(`Verified logged-in visitor from ${location?.city || 'unknown'}`);
                });
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

        // Human verification - triggered by user interaction
        if (msg.type === 'verify_human') {
          if (!client.humanVerified) {
            client.humanVerified = true;
            broadcastViewerCount();

            // Record visit for map if not already done
            const pending = pendingVisits.get(clientId);
            if (pending && !pending.verified) {
              pending.verified = true;
              geolocateIP(pending.ip).then(location => {
                recordVisit(location);
                console.log(`Verified human visitor from ${location?.city || 'unknown'}`);
              });
            }
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

          if (isRateLimited(clientId)) {
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
      rateLimits.delete(clientId);
      pendingVisits.delete(clientId);
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
