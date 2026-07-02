let cameras = [];
let currentCamera = null;
let hls = null;
let ws = null;
// Session lives in the httpOnly `sf_session` cookie, not in JS. Clear any token a
// previous version persisted so script can no longer read it. `authToken` stays as
// a vestigial null; login state is tracked via currentUser.
let authToken = null;
try { localStorage.removeItem('authToken'); } catch (e) {}
let currentUser = null;
let isAdmin = false;
let isApproved = false;
let requireApproval = false;
let chatHistory = [];
let visitorMap = null;
let visitorMarkers = [];
let humanVerified = false;

async function init() {
  await checkStatus();
  await checkAuth();
  updateContentVisibility();
  if (isApproved || !requireApproval) {
    await loadCameras();
    loadFavorites();
    loadMotionTimelapse();
    loadChickGrowth();
    loadVisitorStats();
  }
  loadWeather();
  setupChat();
  setupAuthUI();
  updateNightMode();
  setInterval(updateNightMode, 60000);
  setInterval(loadWeather, 15 * 60000);
}

function setupCollapsibleSections() {
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  document.querySelectorAll('details.collapsible-section').forEach(details => {
    const storageKey = `section-open-${details.id}`;
    const stored = localStorage.getItem(storageKey);
    if (stored !== null) {
      details.open = stored === 'true';
    } else if (isMobile) {
      details.open = false;
    }
    details.addEventListener('toggle', () => {
      localStorage.setItem(storageKey, details.open);
      // Leaflet renders blank/off-center if it was created in a collapsed (zero-
      // size) section; re-measure when the visitor map's section is opened.
      if (details.open && details.id === 'visitors-section' && visitorMap) {
        visitorMap.invalidateSize();
      }
    });
  });
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
    'video-container', 'chat-messages',
    'motion-timelapse-section', 'chick-growth-section', 'favorites-section', 'visitors-section'
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
  // Always ask the server — auth is via the session cookie now, not a JS token.
  try {
    const res = await fetch('/api/me');
    const data = await res.json();

    if (data.loggedIn) {
      currentUser = data.username;
      isAdmin = data.isAdmin;
      isApproved = data.approved;
      requireApproval = data.requireApproval;
      showLoggedInState(true);
    } else {
      currentUser = null;
    }
  } catch (err) {
    console.error('Auth check failed:', err);
  }
}

function showLoggedInState(skipContentLoad = false) {
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
    document.getElementById('privacy-toggle').classList.remove('hidden');
    loadPrivacyState();
    rerenderChat();
  }

  updateContentVisibility();

  if (!skipContentLoad && (isApproved || !requireApproval)) {
    loadCameras();
    loadFavorites();
    loadChickGrowth();
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
  document.getElementById('privacy-toggle').onclick = togglePrivacyMode;

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

    currentUser = data.username;
    isAdmin = data.isAdmin;
    isApproved = data.approved || false;
    requireApproval = data.requireApproval || false;

    // The server set the httpOnly session cookie on this response. Reconnect the
    // chat socket so its new handshake carries the cookie and authenticates.
    setupChat();
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

    currentUser = data.username;
    isAdmin = data.isAdmin;

    // Session cookie is set on this response; reconnect chat to authenticate it.
    setupChat();
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
      headers: {}
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
  document.getElementById('privacy-toggle').classList.add('hidden');
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
    const headers = {};
    const res = await fetch('/config/cameras', { headers });
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

    const savedCamId = localStorage.getItem('selectedCamera');
    const savedCam = savedCamId ? cameras.find(c => c.id === savedCamId) : null;

    if (savedCam) {
      const btn = [...tabs.querySelectorAll('.camera-tab')].find(t => t.textContent === savedCam.name);
      if (btn) selectCamera(savedCam, btn);
      else showAllCams(tabs.querySelector('.camera-tab'));
    } else if (cameras.length > 1) {
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
  localStorage.removeItem('selectedCamera');
  document.querySelectorAll('.camera-tab').forEach(t => t.classList.remove('active'));
  tabBtn.classList.add('active');

  document.getElementById('video-wrapper').classList.add('hidden');
  document.getElementById('video-grid').classList.remove('hidden');

  const ptzEl = document.getElementById('ptz-controls');
  if (ptzEl) ptzEl.classList.add('hidden');
  const ptzExtEl = document.getElementById('ptz-extended');
  if (ptzExtEl) ptzExtEl.classList.add('hidden');

  if (hls) { hls.destroy(); hls = null; }
  destroyGridPlayers();

  const grid = document.getElementById('video-grid');
  grid.innerHTML = '';

  cameras.forEach((cam) => {
    const card = document.createElement('div');
    card.className = 'grid-cam';
    card.innerHTML = `<video autoplay muted playsinline></video><div class="grid-cam-label">${cam.name}</div>`;
    grid.appendChild(card);

    const label = card.querySelector('.grid-cam-label');
    label.onclick = () => {
      const btn = [...document.querySelectorAll('.camera-tab')].find(t => t.textContent === cam.name);
      selectCamera(cam, btn);
    };

    const video = card.querySelector('video');
    video.onclick = (e) => e.stopPropagation();
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
  localStorage.setItem('selectedCamera', cam.id);

  document.querySelectorAll('.camera-tab').forEach(t => t.classList.remove('active'));
  tabBtn.classList.add('active');

  document.getElementById('video-wrapper').classList.remove('hidden');
  document.getElementById('video-grid').classList.add('hidden');
  destroyGridPlayers();

  playStream(cam.streamUrl, !!cam.ptz);
  updatePtzControls(cam);
  updatePtzExtended(cam);
}

function playStream(url, lowLatency) {
  const video = document.getElementById('video-player');
  showVideoOverlay('Loading stream...');

  if (hls) {
    hls.destroy();
    hls = null;
  }

  if (Hls.isSupported()) {
    const hlsConfig = lowLatency ? {
      enableWorker: true,
      lowLatencyMode: true,
      liveSyncDurationCount: 1,
      liveMaxLatencyDurationCount: 3,
      maxBufferLength: 2,
      maxMaxBufferLength: 3,
      backBufferLength: 0,
      manifestLoadingTimeOut: 15000,
      levelLoadingTimeOut: 15000,
      fragLoadingTimeOut: 15000
    } : {
      enableWorker: true,
      lowLatencyMode: false,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 10,
      manifestLoadingTimeOut: 15000,
      levelLoadingTimeOut: 15000,
      fragLoadingTimeOut: 15000
    };
    hls = new Hls(hlsConfig);

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
          if (networkRetries < 30) {
            setTimeout(() => hls.startLoad(), 5000);
          } else {
            showVideoOverlay('Camera offline');
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
      requestAnimationFrame(() => {
        messages.scrollTop = messages.scrollHeight;
      });
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

// Escape for safe interpolation into HTML TEXT or attribute VALUES (quotes
// included). NOTE: NOT sufficient inside an inline event handler like
// onclick="fn('...')" — the browser HTML-decodes the attribute before the JS
// parses, so an escaped quote decodes back and breaks out. Use jsArg() there.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}

// Safely embed a value as a quoted JS-string argument inside an inline event
// handler attribute, e.g. onclick="fn(${jsArg(x)})". JSON.stringify escapes the
// JS-string layer; escapeHtml then makes it safe in the HTML-attribute layer.
function jsArg(value) {
  return escapeHtml(JSON.stringify(String(value)));
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
    deleteBtn = `<button class="delete-msg-btn" onclick="deleteMessage(${jsArg(msg.id)})" title="Delete">x</button>`;
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

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

let lightboxInstance = null;
function refreshLightbox() {
  if (lightboxInstance) lightboxInstance.destroy();
  lightboxInstance = GLightbox({
    touchNavigation: true,
    loop: true,
    closeOnOutsideClick: true
  });
}

async function loadMotionTimelapse() {
  try {
    const res = await fetch('/api/motion-timelapse');
    const videos = await res.json();
    const list = document.getElementById('motion-timelapse-list');

    if (videos.length === 0) {
      list.innerHTML = '<p class="no-recordings">No motion timelapses yet — first one generates after midnight tonight</p>';
      return;
    }

    const weekly = videos.find(v => v.filename === 'motion-timelapse-weekly.mp4');
    const daily = videos.filter(v => v.filename !== 'motion-timelapse-weekly.mp4');

    let html = '';

    if (weekly) {
      html += `
        <div class="timelapse-weekly">
          <h3>Last 7 Days</h3>
          <video src="${weekly.url}" controls preload="none" data-video="${weekly.filename}"></video>
        </div>
      `;
    }

    if (daily.length > 0) {
      html += daily.map(vid => {
        const date = vid.filename.replace('motion-timelapse-', '').replace('.mp4', '');
        const size = formatSize(vid.size);
        return `
          <div class="timelapse-card">
            <video src="${vid.url}" controls preload="none" poster="" data-video="${vid.filename}"></video>
            <div class="timelapse-info">
              <span class="timelapse-date">${date}</span>
              <span class="timelapse-meta">${size}</span>
            </div>
          </div>
        `;
      }).join('');
    }

    list.innerHTML = html;
  } catch (err) {
    console.error('Failed to load motion timelapse:', err);
  }
}

async function loadChickGrowth() {
  try {
    const res = await fetch('/api/chick-growth');
    const data = await res.json();
    const container = document.getElementById('chick-growth-content');

    if (data.frames.length === 0 && !data.video) {
      container.innerHTML = '<p class="no-recordings">Growth timelapse starting soon — one photo saved each day</p>';
      return;
    }

    let html = '';

    if (data.video) {
      html += `
        <div class="timelapse-card">
          <h3>Growth Video</h3>
          <video controls preload="metadata" playsinline>
            <source src="${data.video.url}" type="video/mp4">
          </video>
        </div>
      `;
    }

    if (data.frames.length > 0) {
      html += '<div class="motion-gallery">';
      html += data.frames.map(frame => {
        const dateLabel = new Date(frame.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const deleteBtn = isAdmin ? `<button class="motion-delete-btn" onclick="deleteGrowthFrame(${jsArg(frame.filename)}, event)" title="Delete">x</button>` : '';
        return `
          <div class="motion-thumb">
            <a href="${frame.url}" class="glightbox" data-gallery="growth" data-description="${dateLabel}">
              <img src="${frame.url}" alt="Growth ${dateLabel}" loading="lazy">
            </a>
            <span class="motion-time">${dateLabel}${deleteBtn}</span>
          </div>
        `;
      }).join('');
      html += '</div>';
    }

    container.innerHTML = html;
    refreshLightbox();
  } catch (err) {
    console.error('Failed to load chick growth:', err);
  }
}

async function deleteGrowthFrame(filename, event) {
  event.preventDefault();
  event.stopPropagation();
  if (!confirm('Delete this growth frame?')) return;
  try {
    const res = await fetch(`/api/admin/chick-growth/${filename}`, {
      method: 'DELETE',
      headers: {}
    });
    if ((await res.json()).success) {
      event.target.closest('.motion-thumb').remove();
    }
  } catch (err) {
    console.error('Failed to delete growth frame:', err);
  }
}

async function loadFavorites() {
  try {
    const res = await fetch('/api/favorites');
    const favorites = await res.json();
    const list = document.getElementById('favorites-list');

    if (!Array.isArray(favorites) || favorites.length === 0) {
      list.innerHTML = '<p class="no-recordings">No favorites yet — admin can star frames from the Motion Frames tab</p>';
      return;
    }

    list.innerHTML = '<div class="favorites-grid">' + favorites.map(fav => {
      const dateMatch = fav.filename.match(/(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(\d{2})/);
      const cam = fav.cam || fav.filename.split('_')[0];
      let label = fav.filename;
      if (dateMatch) {
        const d = new Date(dateMatch[1] + 'T12:00:00');
        label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + dateMatch[2] + ':' + dateMatch[3];
      }
      const deleteBtn = isAdmin ? `<button class="motion-delete-btn" onclick="deleteFavorite(${jsArg(fav.filename)}, event)" title="Remove">x</button>` : '';
      return `
        <div class="favorites-thumb" id="fav-${escapeHtml(fav.filename)}">
          <a href="${fav.url}" class="glightbox" data-gallery="favorites" data-description="${escapeHtml(cam)} — ${label}">
            <img src="${fav.url}" alt="${label}" loading="lazy">
          </a>
          <span class="favorites-label">${escapeHtml(cam)} — ${label}${deleteBtn}</span>
        </div>
      `;
    }).join('') + '</div>';
    refreshLightbox();
  } catch (err) {
    console.error('Failed to load favorites:', err);
  }
}

async function deleteFavorite(filename, event) {
  event.preventDefault();
  event.stopPropagation();
  if (!confirm('Remove this favorite?')) return;
  try {
    const res = await fetch(`/api/admin/favorites/${filename}`, {
      method: 'DELETE',
      headers: {}
    });
    if ((await res.json()).success) {
      const el = document.getElementById(`fav-${filename}`);
      if (el) el.remove();
    }
  } catch (err) {
    console.error('Failed to delete favorite:', err);
  }
}

async function loadVisitorStats() {
  try {
    const res = await fetch('/api/stats');
    const stats = await res.json();

    // Update total views counter
    document.getElementById('total-views').innerHTML =
      `Total views: <strong>${stats.totalViews.toLocaleString()}</strong>`;

    // Create the map once; on subsequent calls just refresh the markers (avoids
    // "Map container is already initialized" if loadVisitorStats runs twice).
    if (!visitorMap) {
      visitorMap = L.map('visitor-map', {
        maxBounds: [[-90, -180], [90, 180]],
        maxBoundsViscosity: 1.0,
        minZoom: 2
      }).setView([39, -98], 3);

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        noWrap: true
      }).addTo(visitorMap);
    } else {
      visitorMarkers.forEach(m => visitorMap.removeLayer(m));
    }
    visitorMarkers = [];

    const chickenIcon = L.divIcon({
      className: 'visitor-marker',
      html: '<span style="font-size: 20px;">🐔</span>',
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });

    stats.visitors.forEach(visitor => {
      const marker = L.marker([visitor.lat, visitor.lng], { icon: chickenIcon })
        .addTo(visitorMap)
        .bindPopup(`${visitor.city}, ${visitor.country}`);
      visitorMarkers.push(marker);
    });

    // The map may have been created inside a collapsed <details> (zero-size on
    // mobile); re-measure so tiles/markers aren't rendered off-center.
    visitorMap.invalidateSize();

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


// Weather overlay
async function loadWeather() {
  try {
    const res = await fetch('/api/weather');
    if (!res.ok) return;
    const weather = await res.json();

    const el = document.getElementById('weather-widget');
    if (!el) return;

    const icon = getWeatherIcon(weather.description);
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

function getWeatherIcon(desc) {
  if (!desc) return '🌡️';
  const d = desc.toLowerCase();
  if (d.includes('thunder') || d.includes('storm')) return '⛈️';
  if (d.includes('snow') || d.includes('blizzard') || d.includes('sleet')) return '🌨️';
  if (d.includes('rain') || d.includes('drizzle') || d.includes('shower')) return '🌧️';
  if (d.includes('fog') || d.includes('haze') || d.includes('mist')) return '🌫️';
  if (d.includes('cloud') || d.includes('overcast')) return '☁️';
  if (d.includes('partly') || d.includes('mostly clear')) return '⛅';
  if (d.includes('clear') || d.includes('sunny') || d.includes('fair')) return '☀️';
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

// Privacy mode (admin kill switch)
async function loadPrivacyState() {
  try {
    const res = await fetch('/api/admin/privacy-mode', {
      headers: {}
    });
    const data = await res.json();
    const btn = document.getElementById('privacy-toggle');
    if (data.enabled) {
      btn.classList.add('active');
      btn.textContent = 'DARK';
    } else {
      btn.classList.remove('active');
      btn.textContent = 'Go Dark';
    }
  } catch (err) {
    console.error('Failed to load privacy state:', err);
  }
}

async function togglePrivacyMode() {
  try {
    const res = await fetch('/api/admin/privacy-mode', {
      method: 'POST',
      headers: {}
    });
    const data = await res.json();
    const btn = document.getElementById('privacy-toggle');
    if (data.enabled) {
      btn.classList.add('active');
      btn.textContent = 'DARK';
    } else {
      btn.classList.remove('active');
      btn.textContent = 'Go Dark';
      loadCameras();
    }
  } catch (err) {
    console.error('Failed to toggle privacy mode:', err);
  }
}

// --- PTZ Controls ---

let ptzActive = false;

function updatePtzControls(cam) {
  let container = document.getElementById('ptz-controls');
  if (!container) {
    container = createPtzControls();
  }

  if (cam && cam.hasPtz && currentUser && (cam.hasPtzDriving || isAdmin)) {
    container.classList.remove('hidden');
    container.dataset.camId = cam.id;
    const zoomBtns = container.querySelector('.ptz-zoom');
    if (zoomBtns) {
      zoomBtns.classList.toggle('hidden', !cam.ptzCapabilities.includes('zoom'));
    }
  } else {
    container.classList.add('hidden');
  }
}

function createPtzControls() {
  const wrapper = document.getElementById('video-wrapper');
  const container = document.createElement('div');
  container.id = 'ptz-controls';
  container.className = 'hidden';
  container.innerHTML = `
    <div class="ptz-dpad">
      <button class="ptz-btn ptz-up" data-op="Up" title="Tilt Up">&#9650;</button>
      <button class="ptz-btn ptz-left" data-op="Left" title="Pan Left">&#9664;</button>
      <button class="ptz-btn ptz-center" data-op="Stop" title="Stop">&#9632;</button>
      <button class="ptz-btn ptz-right" data-op="Right" title="Pan Right">&#9654;</button>
      <button class="ptz-btn ptz-down" data-op="Down" title="Tilt Down">&#9660;</button>
      <button class="ptz-btn ptz-up-left" data-op="LeftUp" title="Up-Left">&#8598;</button>
      <button class="ptz-btn ptz-up-right" data-op="RightUp" title="Up-Right">&#8599;</button>
      <button class="ptz-btn ptz-down-left" data-op="LeftDown" title="Down-Left">&#8601;</button>
      <button class="ptz-btn ptz-down-right" data-op="RightDown" title="Down-Right">&#8600;</button>
    </div>
    <div class="ptz-zoom">
      <button class="ptz-btn ptz-zoom-in" data-op="ZoomInc" title="Zoom In">+</button>
      <button class="ptz-btn ptz-zoom-out" data-op="ZoomDec" title="Zoom Out">&minus;</button>
    </div>
  `;

  wrapper.appendChild(container);

  container.querySelectorAll('.ptz-btn').forEach(btn => {
    const op = btn.dataset.op;

    if (op === 'Stop') {
      btn.addEventListener('click', () => sendPtz('Stop'));
      return;
    }

    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      ptzActive = true;
      sendPtz(op);
    });
    btn.addEventListener('mouseup', () => {
      ptzActive = false;
      sendPtz('Stop');
    });
    btn.addEventListener('mouseleave', () => {
      if (ptzActive) {
        ptzActive = false;
        sendPtz('Stop');
      }
    });

    btn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      ptzActive = true;
      sendPtz(op);
    });
    btn.addEventListener('touchend', (e) => {
      e.preventDefault();
      ptzActive = false;
      sendPtz('Stop');
    });
    btn.addEventListener('touchcancel', () => {
      ptzActive = false;
      sendPtz('Stop');
    });
  });

  return container;
}

async function sendPtz(op) {
  const container = document.getElementById('ptz-controls');
  if (!container) return;
  const camId = container.dataset.camId;
  if (!camId || !currentUser) return;

  try {
    await fetch(`/api/camera/${encodeURIComponent(camId)}/ptz`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ op })
    });
  } catch (err) {
    console.error('PTZ command failed:', err);
  }
}

// --- PTZ Extended Controls (Presets, Tracking, Guard) ---

function updatePtzExtended(cam) {
  const el = document.getElementById('ptz-extended');
  if (!el) return;

  if (cam && cam.hasPtz && currentUser) {
    el.classList.remove('hidden');
    el.dataset.camId = cam.id;
    document.querySelectorAll('#ptz-extended .admin-only').forEach(section => {
      section.classList.toggle('hidden', !isAdmin);
    });
    loadPresets();
    if (isAdmin) loadTracking();
    if (isAdmin) loadGuard();
  } else {
    el.classList.add('hidden');
  }
}

async function loadPresets() {
  const container = document.getElementById('ptz-extended');
  if (!container) return;
  const camId = container.dataset.camId;
  const pillsEl = document.getElementById('preset-pills');

  try {
    const resp = await fetch(`/api/camera/${encodeURIComponent(camId)}/presets`, {
      headers: {}
    });
    const presets = await resp.json();
    pillsEl.innerHTML = presets.map(p => {
      const deleteBtn = isAdmin
        ? `<button class="preset-pill-delete" onclick="event.stopPropagation();deletePreset(${jsArg(p.token)})">&times;</button>`
        : '';
      return `<button class="preset-pill" onclick="gotoPreset(${jsArg(p.token)})">${escapeHtml(p.name)}${deleteBtn}</button>`;
    }).join('');
    if (presets.length === 0) {
      pillsEl.innerHTML = '<span style="font-size:0.8rem;color:#888;">No presets saved</span>';
    }
  } catch (err) {
    console.error('Failed to load presets:', err);
  }
}

async function gotoPreset(token) {
  const container = document.getElementById('ptz-extended');
  const camId = container.dataset.camId;
  const pills = document.querySelectorAll('.preset-pill');
  pills.forEach(p => p.disabled = true);

  try {
    await fetch(`/api/camera/${encodeURIComponent(camId)}/preset/${encodeURIComponent(token)}/goto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('Goto preset failed:', err);
  } finally {
    setTimeout(() => pills.forEach(p => p.disabled = false), 1000);
  }
}

async function savePreset() {
  const container = document.getElementById('ptz-extended');
  const camId = container.dataset.camId;
  const input = document.getElementById('preset-name-input');
  const name = input.value.trim();
  if (!name) return;

  try {
    const resp = await fetch(`/api/camera/${encodeURIComponent(camId)}/preset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (resp.ok) {
      input.value = '';
      loadPresets();
    }
  } catch (err) {
    console.error('Save preset failed:', err);
  }
}

async function deletePreset(token) {
  const container = document.getElementById('ptz-extended');
  const camId = container.dataset.camId;

  try {
    const resp = await fetch(`/api/camera/${encodeURIComponent(camId)}/preset/${encodeURIComponent(token)}`, {
      method: 'DELETE',
      headers: {}
    });
    if (resp.ok) loadPresets();
  } catch (err) {
    console.error('Delete preset failed:', err);
  }
}

async function loadTracking() {
  const container = document.getElementById('ptz-extended');
  if (!container) return;
  const camId = container.dataset.camId;

  try {
    const resp = await fetch(`/api/camera/${encodeURIComponent(camId)}/tracking`, {
      headers: {}
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const toggle = document.getElementById('autotrack-toggle');
    const label = document.getElementById('autotrack-label');
    const targets = document.getElementById('track-targets');

    toggle.checked = data.aiTrack;
    label.textContent = data.aiTrack ? 'On' : 'Off';
    targets.classList.toggle('hidden', !data.aiTrack);
    document.getElementById('track-back-times').classList.toggle('hidden', !data.aiTrack);

    document.getElementById('track-people').checked = data.trackType.people;
    document.getElementById('track-animals').checked = data.trackType.dogCat;
    document.getElementById('track-vehicles').checked = data.trackType.vehicle;
    document.getElementById('track-stop-back').value = data.aiStopBackTime || 0;
    document.getElementById('track-disappear-back').value = data.aiDisappearBackTime || 0;
  } catch (err) {
    console.error('Failed to load tracking config:', err);
  }
}

async function toggleAutotrack() {
  const container = document.getElementById('ptz-extended');
  const camId = container.dataset.camId;
  const toggle = document.getElementById('autotrack-toggle');
  const label = document.getElementById('autotrack-label');
  const targets = document.getElementById('track-targets');
  const enabled = toggle.checked;

  label.textContent = enabled ? 'On' : 'Off';
  targets.classList.toggle('hidden', !enabled);
  document.getElementById('track-back-times').classList.toggle('hidden', !enabled);

  try {
    const resp = await fetch(`/api/camera/${encodeURIComponent(camId)}/tracking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aiTrack: enabled })
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      console.error('Toggle autotrack response:', resp.status, err);
    }
  } catch (err) {
    console.error('Toggle autotrack failed:', err);
    toggle.checked = !enabled;
    label.textContent = !enabled ? 'On' : 'Off';
    targets.classList.toggle('hidden', enabled);
  }
}

async function updateTrackTypes() {
  const container = document.getElementById('ptz-extended');
  const camId = container.dataset.camId;

  const trackType = {
    people: document.getElementById('track-people').checked,
    dogCat: document.getElementById('track-animals').checked,
    vehicle: document.getElementById('track-vehicles').checked,
    face: false
  };

  try {
    await fetch(`/api/camera/${encodeURIComponent(camId)}/tracking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackType })
    });
  } catch (err) {
    console.error('Update track types failed:', err);
  }
}

async function updateTrackBackTimes() {
  const container = document.getElementById('ptz-extended');
  const camId = container.dataset.camId;
  const aiStopBackTime = parseInt(document.getElementById('track-stop-back').value) || 0;
  const aiDisappearBackTime = parseInt(document.getElementById('track-disappear-back').value) || 0;

  try {
    await fetch(`/api/camera/${encodeURIComponent(camId)}/tracking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aiStopBackTime, aiDisappearBackTime })
    });
  } catch (err) {
    console.error('Update track back times failed:', err);
  }
}

async function loadGuard() {
  const container = document.getElementById('ptz-extended');
  if (!container) return;
  const camId = container.dataset.camId;

  try {
    const resp = await fetch(`/api/camera/${encodeURIComponent(camId)}/guard`, {
      headers: {}
    });
    const data = await resp.json();
    document.getElementById('guard-toggle').checked = data.enable;
    document.getElementById('guard-timeout').value = data.timeout;
  } catch (err) {
    console.error('Failed to load guard config:', err);
  }
}

async function toggleGuard() {
  const container = document.getElementById('ptz-extended');
  const camId = container.dataset.camId;
  const enable = document.getElementById('guard-toggle').checked;
  const timeout = parseInt(document.getElementById('guard-timeout').value) || 60;

  try {
    await fetch(`/api/camera/${encodeURIComponent(camId)}/guard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enable, timeout })
    });
  } catch (err) {
    console.error('Toggle guard failed:', err);
  }
}

function setupPtzExtended() {
  document.getElementById('autotrack-toggle')?.addEventListener('change', toggleAutotrack);
  document.getElementById('track-people')?.addEventListener('change', updateTrackTypes);
  document.getElementById('track-animals')?.addEventListener('change', updateTrackTypes);
  document.getElementById('track-vehicles')?.addEventListener('change', updateTrackTypes);
  document.getElementById('preset-save-btn')?.addEventListener('click', savePreset);
  document.getElementById('preset-name-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') savePreset();
  });
  document.getElementById('track-stop-back')?.addEventListener('change', updateTrackBackTimes);
  document.getElementById('track-disappear-back')?.addEventListener('change', updateTrackBackTimes);
  document.getElementById('guard-toggle')?.addEventListener('change', toggleGuard);
  document.getElementById('guard-timeout')?.addEventListener('change', toggleGuard);
}

setupPtzExtended();
setupCollapsibleSections();
init();
