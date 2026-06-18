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
    loadRecordings();
    loadTimelapse();
    loadMotionCaptures();
    loadVisitorStats();
  }
  loadWeather();
  setupChat();
  setupAuthUI();
  updateNightMode();
  setInterval(updateNightMode, 60000);
  setInterval(loadWeather, 15 * 60000);
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
  const protectedSections = [
    'video-container', 'chat-messages', 'timelapse-section',
    'motion-section', 'recordings-section', 'visitors-section'
  ];

  if (requireApproval && !isApproved) {
    protectedSections.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });

    if (!currentUser) {
      showLoginRequired();
    } else {
      showPendingApproval();
    }
  } else {
    hideLoginRequired();
    hidePendingApproval();
    protectedSections.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('hidden');
    });
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
    statusEl.innerHTML = `Welcome, ${escapeHtml(currentUser)} (<a href="/admin.html" class="admin-link">Admin</a>)`;
  } else {
    statusEl.textContent = `Welcome, ${currentUser}`;
  }
  document.getElementById('logout-btn').classList.remove('hidden');
  document.getElementById('account-link').classList.remove('hidden');
  document.getElementById('auth-section').classList.add('hidden');
  document.getElementById('chat-input-area').classList.remove('hidden');

  if (isAdmin) {
    document.getElementById('admin-clear-btn').classList.remove('hidden');
    rerenderChat();
  }

  updateContentVisibility();

  if (isApproved || !requireApproval) {
    loadCameras();
    loadRecordings();
    loadTimelapse();
    loadMotionCaptures();
    loadVisitorStats();
  }
}

function showPendingApproval() {
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

  document.getElementById('forgot-password-link').onclick = (e) => {
    e.preventDefault();
    document.getElementById('account-form').classList.add('hidden');
    document.getElementById('forgot-form').classList.remove('hidden');
    hideAuthError();
  };

  document.getElementById('forgot-back-link').onclick = (e) => {
    e.preventDefault();
    document.getElementById('forgot-form').classList.add('hidden');
    document.getElementById('account-form').classList.remove('hidden');
    hideAuthError();
  };

  document.getElementById('forgot-submit-btn').onclick = doForgotPassword;
  document.getElementById('forgot-email').onkeypress = (e) => {
    if (e.key === 'Enter') doForgotPassword();
  };

  document.getElementById('change-password-cancel').onclick = hideChangePasswordModal;
  document.getElementById('change-password-submit').onclick = doChangePassword;

  document.querySelectorAll('.toggle-password').forEach(btn => {
    btn.onclick = () => {
      const input = document.getElementById(btn.dataset.target);
      if (input.type === 'password') {
        input.type = 'text';
        btn.classList.add('active');
      } else {
        input.type = 'password';
        btn.classList.remove('active');
      }
    };
  });
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
    isApproved = data.approved || false;
    requireApproval = data.requireApproval || false;
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
  isApproved = false;

  document.getElementById('user-status').textContent = '';
  document.getElementById('logout-btn').classList.add('hidden');
  document.getElementById('account-link').classList.add('hidden');
  document.getElementById('admin-clear-btn').classList.add('hidden');
  document.getElementById('auth-section').classList.remove('hidden');
  document.getElementById('chat-input-area').classList.add('hidden');

  if (hls) {
    hls.destroy();
    hls = null;
  }

  updateContentVisibility();

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

let gridPlayers = [];

async function loadCameras() {
  try {
    const res = await fetch('/config/cameras');
    cameras = await res.json();

    const tabs = document.getElementById('camera-tabs');
    tabs.innerHTML = '';

    if (cameras.length > 1) {
      const allBtn = document.createElement('button');
      allBtn.className = 'camera-tab active';
      allBtn.textContent = 'All Cams';
      allBtn.onclick = () => showAllCams(allBtn);
      tabs.appendChild(allBtn);
    }

    cameras.forEach((cam) => {
      const btn = document.createElement('button');
      btn.className = 'camera-tab';
      btn.textContent = cam.name;
      btn.onclick = () => selectCamera(cam, btn);
      tabs.appendChild(btn);
    });

    if (cameras.length > 1) {
      showAllCams(tabs.querySelector('.camera-tab'));
    } else if (cameras.length === 1) {
      selectCamera(cameras[0], tabs.querySelector('.camera-tab'));
    } else {
      showVideoOverlay('No cameras configured');
    }
  } catch (err) {
    console.error('Failed to load cameras:', err);
    showVideoOverlay('Failed to load cameras');
  }
}

function showAllCams(tabBtn) {
  document.querySelectorAll('.camera-tab').forEach(t => t.classList.remove('active'));
  tabBtn.classList.add('active');

  document.getElementById('video-wrapper').classList.add('hidden');
  document.getElementById('video-grid').classList.remove('hidden');

  if (hls) { hls.destroy(); hls = null; }
  destroyGridPlayers();

  const grid = document.getElementById('video-grid');
  grid.innerHTML = '';

  cameras.forEach((cam) => {
    const card = document.createElement('div');
    card.className = 'grid-cam';
    card.innerHTML = `<video autoplay muted></video><div class="grid-cam-label">${cam.name}</div>`;
    card.onclick = () => {
      const btn = [...document.querySelectorAll('.camera-tab')].find(t => t.textContent === cam.name);
      selectCamera(cam, btn);
    };
    grid.appendChild(card);

    const video = card.querySelector('video');
    const hlsPlayer = new Hls({ enableWorker: true, lowLatencyMode: false });
    hlsPlayer.loadSource(cam.streamUrl);
    hlsPlayer.attachMedia(video);
    hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    gridPlayers.push(hlsPlayer);
  });
}

function destroyGridPlayers() {
  gridPlayers.forEach(p => p.destroy());
  gridPlayers = [];
}

function selectCamera(cam, tabBtn) {
  currentCamera = cam;

  document.querySelectorAll('.camera-tab').forEach(t => t.classList.remove('active'));
  tabBtn.classList.add('active');

  document.getElementById('video-wrapper').classList.remove('hidden');
  document.getElementById('video-grid').classList.add('hidden');
  destroyGridPlayers();

  playStream(cam.streamUrl);
}

function playStream(url) {
  const video = document.getElementById('video-player');
  showVideoOverlay('Loading stream...');

  if (hls) {
    hls.destroy();
    hls = null;
  }

  if (Hls.isSupported()) {
    hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 10,
      manifestLoadingTimeOut: 15000,
      levelLoadingTimeOut: 15000,
      fragLoadingTimeOut: 15000
    });

    hls.loadSource(url);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
    });

    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      hideVideoOverlay();
    });

    let networkRetries = 0;

    hls.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          networkRetries++;
          if (networkRetries < 10) {
            setTimeout(() => hls.startLoad(), 3000);
          } else {
            showVideoOverlay('Camera offline — check back soon');
          }
        } else {
          showVideoOverlay('Stream unavailable');
        }
      }
    });

    hls.on(Hls.Events.FRAG_LOADED, () => {
      networkRetries = 0;
    });

    // If video stalls, jump to live edge
    video.addEventListener('waiting', () => {
      if (hls && hls.liveSyncPosition && video.currentTime < hls.liveSyncPosition - 10) {
        video.currentTime = hls.liveSyncPosition;
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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function appendMessage(msg) {
  const messages = document.getElementById('chat-messages');
  const el = document.createElement('div');
  el.className = 'chat-message' + (msg.isRegistered ? ' registered' : '');
  el.id = `msg-${msg.id}`;

  const time = new Date(msg.timestamp).toLocaleTimeString();
  const safeNickname = escapeHtml(msg.nickname);
  const safeContent = escapeHtml(msg.content);

  let deleteBtn = '';
  if (isAdmin && msg.id) {
    deleteBtn = `<button class="delete-msg-btn" onclick="deleteMessage('${escapeHtml(msg.id)}')" title="Delete">x</button>`;
  }

  el.innerHTML = `
    <div class="msg-header">
      <span class="nickname">${safeNickname}${msg.isRegistered ? ' <span class="verified-badge" title="Registered user">&#10003;</span>' : ''}</span>
      <span class="time">${time}</span>
      ${deleteBtn}
    </div>
    <div class="content">${safeContent}</div>
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

async function loadTimelapse() {
  try {
    const res = await fetch('/api/timelapse');
    const videos = await res.json();
    const list = document.getElementById('timelapse-list');

    if (videos.length === 0) {
      list.innerHTML = '<p class="no-recordings">No timelapses yet — first one generates after midnight tonight</p>';
      return;
    }

    list.innerHTML = videos.map(vid => {
      const date = vid.filename.replace('timelapse-', '').replace('.mp4', '');
      const size = formatSize(vid.size);
      return `
        <div class="timelapse-card">
          <video src="${vid.url}" controls preload="none" poster=""></video>
          <div class="timelapse-info">
            <span class="timelapse-date">${date}</span>
            <span class="timelapse-size">${size}</span>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load timelapse:', err);
  }
}

async function loadMotionCaptures() {
  try {
    const res = await fetch('/api/motion-captures');
    const captures = await res.json();
    const gallery = document.getElementById('motion-gallery');

    if (captures.length === 0) {
      gallery.innerHTML = '<p class="no-recordings">No motion captures yet — check back after nightfall</p>';
      return;
    }

    gallery.innerHTML = captures.map(cap => {
      const date = new Date(cap.created);
      const label = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
      const deleteBtn = isAdmin ? `<button class="motion-delete-btn" onclick="deleteMotionCapture('${escapeHtml(cap.filename)}', event)" title="Delete">x</button>` : '';
      return `
        <div class="motion-thumb" id="capture-${escapeHtml(cap.filename)}">
          <a href="${cap.url}" target="_blank">
            <img src="${cap.url}" alt="Motion ${label}" loading="lazy">
          </a>
          <span class="motion-time">${label}${deleteBtn}</span>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load motion captures:', err);
  }
}

async function deleteMotionCapture(filename, event) {
  event.preventDefault();
  event.stopPropagation();
  try {
    const res = await fetch(`/api/admin/motion-captures/${filename}`, {
      method: 'DELETE',
      headers: { 'x-auth-token': authToken }
    });
    if ((await res.json()).success) {
      const el = document.getElementById(`capture-${filename}`);
      if (el) el.remove();
    }
  } catch (err) {
    console.error('Failed to delete capture:', err);
  }
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
      <div class="recording-card" onclick="playRecording('${escapeHtml(rec.filename)}')">
        <div class="filename">${escapeHtml(rec.filename)}</div>
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

async function doForgotPassword() {
  const email = document.getElementById('forgot-email').value.trim();
  if (!email) {
    showAuthError('Please enter your email');
    return;
  }

  try {
    const res = await fetch('/api/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    showSuccessMessage(data.message || 'If an account with that email exists, a reset link has been sent.');
    document.getElementById('forgot-form').classList.add('hidden');
    document.getElementById('account-form').classList.remove('hidden');
  } catch (err) {
    showAuthError('Request failed. Please try again.');
  }
}

function showChangePasswordModal() {
  document.getElementById('change-password-modal').classList.remove('hidden');
  document.getElementById('current-password').value = '';
  document.getElementById('new-password').value = '';
  document.getElementById('confirm-password').value = '';
  document.getElementById('change-password-error').classList.add('hidden');
}

function hideChangePasswordModal() {
  document.getElementById('change-password-modal').classList.add('hidden');
}

async function doChangePassword() {
  const currentPassword = document.getElementById('current-password').value;
  const newPassword = document.getElementById('new-password').value;
  const confirmPassword = document.getElementById('confirm-password').value;
  const errorEl = document.getElementById('change-password-error');

  if (!currentPassword || !newPassword) {
    errorEl.textContent = 'All fields required';
    errorEl.classList.remove('hidden');
    return;
  }

  if (newPassword !== confirmPassword) {
    errorEl.textContent = 'New passwords do not match';
    errorEl.classList.remove('hidden');
    return;
  }

  if (newPassword.length < 4) {
    errorEl.textContent = 'Password must be at least 4 characters';
    errorEl.classList.remove('hidden');
    return;
  }

  try {
    const res = await fetch('/api/change-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-auth-token': authToken
      },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    const data = await res.json();

    if (data.error) {
      errorEl.textContent = data.error;
      errorEl.classList.remove('hidden');
      return;
    }

    hideChangePasswordModal();
    alert('Password changed successfully!');
  } catch (err) {
    errorEl.textContent = 'Failed to change password';
    errorEl.classList.remove('hidden');
  }
}

// Weather overlay
async function loadWeather() {
  try {
    const res = await fetch('/api/weather');
    if (!res.ok) return;
    const weather = await res.json();

    const el = document.getElementById('weather-widget');
    if (!el) return;

    const icon = getWeatherIcon(weather.code);
    el.innerHTML = `
      <span class="weather-icon">${icon}</span>
      <span class="weather-temp">${weather.temp}°F</span>
      <span class="weather-desc">${weather.description}</span>
      <span class="weather-detail">💨 ${weather.windSpeed}mph · 💧 ${weather.humidity}%</span>
    `;
    el.classList.remove('hidden');
  } catch (err) {
    console.error('Weather load failed:', err);
  }
}

function getWeatherIcon(code) {
  if (code === 0) return '☀️';
  if (code <= 2) return '⛅';
  if (code === 3) return '☁️';
  if (code >= 45 && code <= 48) return '🌫️';
  if (code >= 51 && code <= 55) return '🌦️';
  if (code >= 61 && code <= 65) return '🌧️';
  if (code >= 71 && code <= 77) return '🌨️';
  if (code >= 80 && code <= 82) return '🌧️';
  if (code >= 85 && code <= 86) return '🌨️';
  if (code >= 95) return '⛈️';
  return '🌡️';
}

// Night mode badge
function updateNightMode() {
  const hour = new Date().getHours();
  const isNight = hour >= 21 || hour < 6;
  const badge = document.getElementById('night-mode-badge');
  if (!badge) return;

  if (isNight) {
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

init();
