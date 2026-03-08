let cameras = [];
let currentCamera = null;
let hls = null;
let ws = null;
let authToken = localStorage.getItem('authToken');
let currentUser = null;
let isAdmin = false;
let chatHistory = [];
let visitorMap = null;
let humanVerified = false;

async function init() {
  await checkAuth();
  await loadCameras();
  setupChat();
  loadRecordings();
  setupAuthUI();
  loadVisitorStats();
}

async function checkAuth() {
  if (!authToken) return;

  try {
    const res = await fetch('/api/me', {
      headers: { 'x-auth-token': authToken }
    });
    const data = await res.json();

    if (data.loggedIn) {
      currentUser = data.username;
      isAdmin = data.isAdmin;
      showLoggedInState();
    } else {
      localStorage.removeItem('authToken');
      authToken = null;
    }
  } catch (err) {
    console.error('Auth check failed:', err);
  }
}

function showLoggedInState() {
  const statusEl = document.getElementById('user-status');
  if (isAdmin) {
    statusEl.innerHTML = `Welcome, ${currentUser} (<a href="/admin.html" class="admin-link">Admin</a>)`;
  } else {
    statusEl.textContent = `Welcome, ${currentUser}`;
  }
  document.getElementById('logout-btn').classList.remove('hidden');
  document.getElementById('auth-section').classList.add('hidden');
  document.getElementById('chat-input-area').classList.remove('hidden');

  if (isAdmin) {
    document.getElementById('admin-clear-btn').classList.remove('hidden');
    rerenderChat();
  }
}

function rerenderChat() {
  const messages = document.getElementById('chat-messages');
  messages.innerHTML = '';
  chatHistory.forEach(msg => appendMessage(msg));
}

function showGuestState(nickname) {
  document.getElementById('user-status').textContent = `Chatting as: ${nickname}`;
  document.getElementById('auth-section').classList.add('hidden');
  document.getElementById('chat-input-area').classList.remove('hidden');
}

function setupAuthUI() {
  document.getElementById('nickname-btn').onclick = setGuestNickname;
  document.getElementById('nickname-input').onkeypress = (e) => {
    if (e.key === 'Enter') setGuestNickname();
  };

  document.getElementById('login-btn').onclick = doLogin;
  document.getElementById('register-btn').onclick = doRegister;
  document.getElementById('auth-password').onkeypress = (e) => {
    if (e.key === 'Enter') doLogin();
  };

  document.getElementById('logout-btn').onclick = doLogout;
  document.getElementById('admin-clear-btn').onclick = clearChat;
}

function setGuestNickname() {
  const input = document.getElementById('nickname-input');
  const nickname = input.value.trim();

  if (nickname.length >= 2) {
    ws.send(JSON.stringify({ type: 'set_nickname', nickname }));
  } else {
    showAuthError('Nickname must be at least 2 characters');
  }
}

async function doLogin() {
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value;

  if (!username || !password) {
    showAuthError('Please enter username and password');
    return;
  }

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (data.error) {
      showAuthError(data.error);
      return;
    }

    authToken = data.token;
    currentUser = data.username;
    isAdmin = data.isAdmin;
    localStorage.setItem('authToken', authToken);

    ws.send(JSON.stringify({ type: 'auth', token: authToken }));
    showLoggedInState();
    hideAuthError();
  } catch (err) {
    showAuthError('Login failed');
  }
}

async function doRegister() {
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value;

  if (!username || !password) {
    showAuthError('Please enter username and password');
    return;
  }

  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (data.error) {
      showAuthError(data.error);
      return;
    }

    authToken = data.token;
    currentUser = data.username;
    isAdmin = data.isAdmin;
    localStorage.setItem('authToken', authToken);

    ws.send(JSON.stringify({ type: 'auth', token: authToken }));
    showLoggedInState();
    hideAuthError();
  } catch (err) {
    showAuthError('Registration failed');
  }
}

async function doLogout() {
  try {
    await fetch('/api/logout', {
      method: 'POST',
      headers: { 'x-auth-token': authToken }
    });
  } catch (err) {
    console.error('Logout failed:', err);
  }

  localStorage.removeItem('authToken');
  authToken = null;
  currentUser = null;
  isAdmin = false;

  document.getElementById('user-status').textContent = '';
  document.getElementById('logout-btn').classList.add('hidden');
  document.getElementById('admin-clear-btn').classList.add('hidden');
  document.getElementById('auth-section').classList.remove('hidden');
  document.getElementById('chat-input-area').classList.add('hidden');

  // Reconnect WebSocket as unauthenticated
  wsIntentionalClose = true;
  if (ws) ws.close();
  setupChat();
}

function clearChat() {
  if (confirm('Are you sure you want to clear all chat messages?')) {
    ws.send(JSON.stringify({ type: 'admin_clear_chat' }));
  }
}

function deleteMessage(messageId) {
  ws.send(JSON.stringify({ type: 'admin_delete_message', messageId }));
}

function showAuthError(message) {
  const el = document.getElementById('auth-error');
  el.textContent = message;
  el.classList.remove('hidden');
}

function hideAuthError() {
  document.getElementById('auth-error').classList.add('hidden');
}

async function loadCameras() {
  try {
    const res = await fetch('/config/cameras');
    cameras = await res.json();

    const tabs = document.getElementById('camera-tabs');
    tabs.innerHTML = '';

    cameras.forEach((cam, index) => {
      const btn = document.createElement('button');
      btn.className = 'camera-tab' + (index === 0 ? ' active' : '');
      btn.textContent = cam.name;
      btn.onclick = () => selectCamera(cam, btn);
      tabs.appendChild(btn);
    });

    if (cameras.length > 0) {
      selectCamera(cameras[0], tabs.querySelector('.camera-tab'));
    } else {
      showVideoOverlay('No cameras configured');
    }
  } catch (err) {
    console.error('Failed to load cameras:', err);
    showVideoOverlay('Failed to load cameras');
  }
}

function selectCamera(cam, tabBtn) {
  currentCamera = cam;

  document.querySelectorAll('.camera-tab').forEach(t => t.classList.remove('active'));
  tabBtn.classList.add('active');

  playStream(cam.streamUrl);
}

function playStream(url) {
  const video = document.getElementById('video-player');
  hideVideoOverlay();

  if (hls) {
    hls.destroy();
    hls = null;
  }

  if (Hls.isSupported()) {
    hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true
    });

    hls.loadSource(url);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
    });

    hls.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        console.error('HLS error:', data);
        showVideoOverlay('Stream unavailable');
      }
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    video.play().catch(() => {});
  } else {
    showVideoOverlay('HLS not supported in this browser');
  }
}

function showVideoOverlay(message) {
  const overlay = document.getElementById('video-overlay');
  overlay.querySelector('p').textContent = message;
  overlay.classList.remove('hidden');
}

function hideVideoOverlay() {
  document.getElementById('video-overlay').classList.add('hidden');
}

let wsIntentionalClose = false;

function setupChat() {
  // Close existing connection if any
  if (ws && ws.readyState === WebSocket.OPEN) {
    wsIntentionalClose = true;
    ws.close();
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/chat`);
  wsIntentionalClose = false;
  humanVerified = false; // Reset on new connection

  ws.onopen = () => {
    if (authToken) {
      ws.send(JSON.stringify({ type: 'auth', token: authToken }));
    }
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleChatMessage(data);
  };

  ws.onclose = () => {
    if (!wsIntentionalClose) {
      setTimeout(setupChat, 3000);
    }
  };

  document.getElementById('send-btn').onclick = sendMessage;
  document.getElementById('chat-input').onkeypress = (e) => {
    if (e.key === 'Enter') sendMessage();
  };

  // Set up human verification on interaction
  setupHumanVerification();
}

function setupHumanVerification() {
  const verify = () => {
    if (!humanVerified && ws && ws.readyState === 1) {
      humanVerified = true;
      ws.send(JSON.stringify({ type: 'verify_human' }));
      // Remove listeners after verification
      document.removeEventListener('mousemove', verify);
      document.removeEventListener('click', verify);
      document.removeEventListener('scroll', verify);
      document.removeEventListener('touchstart', verify);
      document.removeEventListener('keydown', verify);
    }
  };

  // Wait a bit before adding listeners to avoid immediate triggers
  setTimeout(() => {
    document.addEventListener('mousemove', verify, { once: true });
    document.addEventListener('click', verify, { once: true });
    document.addEventListener('scroll', verify, { once: true });
    document.addEventListener('touchstart', verify, { once: true });
    document.addEventListener('keydown', verify, { once: true });
  }, 1000);
}

function sendMessage() {
  const input = document.getElementById('chat-input');
  const content = input.value.trim();

  if (content && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'chat', content }));
    input.value = '';
  }
}

function handleChatMessage(data) {
  const messages = document.getElementById('chat-messages');

  switch (data.type) {
    case 'history':
      chatHistory = data.messages;
      messages.innerHTML = '';
      data.messages.forEach(msg => appendMessage(msg));
      break;

    case 'chat':
      chatHistory.push(data);
      appendMessage(data);
      break;

    case 'nickname_set':
      showGuestState(data.nickname);
      hideAuthError();
      break;

    case 'auth_success':
      currentUser = data.nickname;
      isAdmin = data.isAdmin;
      showLoggedInState();
      break;

    case 'auth_failed':
      localStorage.removeItem('authToken');
      authToken = null;
      break;

    case 'chat_cleared':
      chatHistory = [];
      messages.innerHTML = '';
      appendSystemMessage('Chat has been cleared by admin');
      break;

    case 'message_deleted':
      chatHistory = chatHistory.filter(m => m.id !== data.messageId);
      const msgEl = document.getElementById(`msg-${data.messageId}`);
      if (msgEl) msgEl.remove();
      break;

    case 'error':
      showAuthError(data.message);
      break;

    case 'viewer_count':
      updateViewerCount(data.count);
      break;
  }
}

function updateViewerCount(count) {
  const el = document.getElementById('viewer-count');
  if (count === 1) {
    el.textContent = '1 viewer';
  } else {
    el.textContent = `${count} viewers`;
  }
}

function appendMessage(msg) {
  const messages = document.getElementById('chat-messages');
  const el = document.createElement('div');
  el.className = 'chat-message' + (msg.isRegistered ? ' registered' : '');
  el.id = `msg-${msg.id}`;

  const time = new Date(msg.timestamp).toLocaleTimeString();

  let deleteBtn = '';
  if (isAdmin && msg.id) {
    deleteBtn = `<button class="delete-msg-btn" onclick="deleteMessage('${msg.id}')" title="Delete">x</button>`;
  }

  el.innerHTML = `
    <div class="msg-header">
      <span class="nickname">${msg.nickname}${msg.isRegistered ? ' <span class="verified-badge" title="Registered user">✓</span>' : ''}</span>
      <span class="time">${time}</span>
      ${deleteBtn}
    </div>
    <div class="content">${msg.content}</div>
  `;

  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
}

function appendSystemMessage(text) {
  const messages = document.getElementById('chat-messages');
  const el = document.createElement('div');
  el.className = 'system-message';
  el.textContent = text;
  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
}

async function loadRecordings() {
  try {
    const res = await fetch('/api/recordings');
    const recordings = await res.json();

    const list = document.getElementById('recordings-list');

    if (recordings.length === 0) {
      list.innerHTML = '<p class="no-recordings">No recordings yet</p>';
      return;
    }

    list.innerHTML = recordings.map(rec => `
      <div class="recording-card" onclick="playRecording('${rec.filename}')">
        <div class="filename">${rec.filename}</div>
        <div class="meta">
          ${formatSize(rec.size)} - ${new Date(rec.created).toLocaleString()}
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to load recordings:', err);
  }
}

function playRecording(filename) {
  const url = `/api/recordings/${filename}`;
  playStream(url);
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function loadVisitorStats() {
  try {
    const res = await fetch('/api/stats');
    const stats = await res.json();

    // Update total views counter
    document.getElementById('total-views').innerHTML =
      `Total views: <strong>${stats.totalViews.toLocaleString()}</strong>`;

    // Initialize map with bounds to prevent world duplication
    visitorMap = L.map('visitor-map', {
      maxBounds: [[-90, -180], [90, 180]],
      maxBoundsViscosity: 1.0,
      minZoom: 2
    }).setView([30, 0], 2);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      noWrap: true
    }).addTo(visitorMap);

    // Add visitor markers
    const chickenIcon = L.divIcon({
      className: 'visitor-marker',
      html: '<span style="font-size: 20px;">🐔</span>',
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });

    stats.visitors.forEach(visitor => {
      L.marker([visitor.lat, visitor.lng], { icon: chickenIcon })
        .addTo(visitorMap)
        .bindPopup(`${visitor.city}, ${visitor.country}`);
    });

  } catch (err) {
    console.error('Failed to load visitor stats:', err);
  }
}

init();
