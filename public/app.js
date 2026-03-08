let cameras = [];
let currentCamera = null;
let hls = null;
let ws = null;
let authToken = localStorage.getItem('authToken');
let currentUser = null;
let isAdmin = false;
let isApproved = false;
let requireApproval = false;
let chatHistory = [];
let visitorMap = null;
let humanVerified = false;

async function init() {
  await checkStatus();
  await checkAuth();
  updateContentVisibility();
  if (isApproved || !requireApproval) {
    await loadCameras();
  }
  loadRecordings();
  loadVisitorStats();
  setupChat();
  setupAuthUI();
}

async function checkStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    requireApproval = data.requireApproval || false;
  } catch (err) {
    console.error('Failed to check status:', err);
  }
}

function updateContentVisibility() {
  // If approval is required and user is not approved, hide content
  if (requireApproval && !isApproved) {
    document.getElementById('video-container').classList.add('hidden');
    document.getElementById('chat-messages').classList.add('hidden');

    // Show appropriate message based on login state
    if (!currentUser) {
      showLoginRequired();
    } else {
      showPendingApproval();
    }
  } else {
    hideLoginRequired();
    hidePendingApproval();
    document.getElementById('video-container').classList.remove('hidden');
    document.getElementById('chat-messages').classList.remove('hidden');
  }
}

function showLoginRequired() {
  let el = document.getElementById('login-required');
  if (!el) {
    el = document.createElement('div');
    el.id = 'login-required';
    el.className = 'pending-approval-message';
    el.innerHTML = `
      <h2>Login Required</h2>
      <p>You must register and be approved to view the live stream.</p>
      <p>Please create an account using the form in the chat area.</p>
    `;
    document.querySelector('main').appendChild(el);
  }
}

function hideLoginRequired() {
  const el = document.getElementById('login-required');
  if (el) el.remove();
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
      isApproved = data.approved;
      requireApproval = data.requireApproval;
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

  updateContentVisibility();
}

function showPendingApproval() {
  // Hide video and show pending message
  document.getElementById('video-container').classList.add('hidden');
  document.getElementById('chat-container').classList.add('hidden');
  document.getElementById('recordings-section').classList.add('hidden');
  document.getElementById('visitors-section').classList.add('hidden');

  let pendingEl = document.getElementById('pending-approval');
  if (!pendingEl) {
    pendingEl = document.createElement('div');
    pendingEl.id = 'pending-approval';
    pendingEl.className = 'pending-approval-message';
    pendingEl.innerHTML = `
      <h2>Account Pending Approval</h2>
      <p>Your account is awaiting admin approval. You'll receive an email once approved.</p>
      <p>Check back soon!</p>
    `;
    document.querySelector('main').appendChild(pendingEl);
  }
}

function hidePendingApproval() {
  const pendingEl = document.getElementById('pending-approval');
  if (pendingEl) pendingEl.remove();
  document.getElementById('video-container').classList.remove('hidden');
  document.getElementById('chat-container').classList.remove('hidden');
  document.getElementById('recordings-section').classList.remove('hidden');
  document.getElementById('visitors-section').classList.remove('hidden');
}

function rerenderChat() {
  const messages = document.getElementById('chat-messages');
  messages.innerHTML = '';
  chatHistory.forEach(msg => appendMessage(msg));
}

function setupAuthUI() {
  document.getElementById('login-btn').onclick = doLogin;
  document.getElementById('register-btn').onclick = doRegister;
  document.getElementById('auth-password').onkeypress = (e) => {
    if (e.key === 'Enter') doLogin();
  };

  document.getElementById('logout-btn').onclick = doLogout;
  document.getElementById('admin-clear-btn').onclick = clearChat;
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

    if (data.pendingApproval) {
      showAuthError(data.message);
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
  const email = document.getElementById('auth-email').value.trim();

  if (!username || !password) {
    showAuthError('Please enter username and password');
    return;
  }

  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, email })
    });
    const data = await res.json();

    if (data.error) {
      showAuthError(data.error);
      return;
    }

    if (data.pendingApproval) {
      showSuccessMessage(data.message);
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

function showSuccessMessage(message) {
  const el = document.getElementById('auth-error');
  el.textContent = message;
  el.classList.remove('hidden');
  el.style.background = '#d4edda';
  el.style.color = '#155724';
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
