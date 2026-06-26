let authToken = localStorage.getItem('authToken');
let currentUser = null;
let isAdmin = false;
let ws = null;
let infraRefreshInterval = null;
let adminUsers = [];
let userSortCol = 'created';
let userSortAsc = false;
let activityData = [];

// Escape for safe interpolation into HTML TEXT or attribute VALUES (quotes
// included). NOTE: this is NOT sufficient for a value placed inside an inline
// event handler like onclick="fn('...')" — there the browser HTML-decodes the
// attribute before the JS parses, so an escaped quote decodes back and breaks
// out of the JS string. Use jsArg() for those.
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
// JS-string layer (quotes, backslashes, control chars); escapeHtml then makes
// the result safe in the HTML-attribute layer. Emits its own surrounding quotes.
function jsArg(value) {
  return escapeHtml(JSON.stringify(String(value)));
}

async function init() {
  await checkAuth();
}

async function checkAuth() {
  document.getElementById('admin-loading').classList.remove('hidden');
  document.getElementById('admin-unauthorized').classList.add('hidden');
  document.getElementById('admin-panel').classList.add('hidden');

  if (!authToken) {
    showUnauthorized();
    return;
  }

  try {
    const res = await fetch('/api/me', {
      headers: { 'x-auth-token': authToken }
    });
    const data = await res.json();

    if (data.loggedIn && data.isAdmin) {
      currentUser = data.username;
      isAdmin = true;
      showAdminPanel();
    } else {
      showUnauthorized();
    }
  } catch (err) {
    console.error('Auth check failed:', err);
    showUnauthorized();
  }
}

function showUnauthorized() {
  document.getElementById('admin-loading').classList.add('hidden');
  document.getElementById('admin-unauthorized').classList.remove('hidden');
  document.getElementById('admin-panel').classList.add('hidden');
}

function showAdminPanel() {
  document.getElementById('admin-loading').classList.add('hidden');
  document.getElementById('admin-unauthorized').classList.add('hidden');
  document.getElementById('admin-panel').classList.remove('hidden');

  document.getElementById('user-status').textContent = `Welcome, ${currentUser} (Admin)`;
  document.getElementById('logout-btn').classList.remove('hidden');
  document.getElementById('logout-btn').onclick = doLogout;

  setupAdminTabs();
  setupChatConnection();
  loadAdminData();
  loadDashboard();
}

async function approveUser(username) {
  try {
    const res = await fetch(`/api/admin/users/${username}/approve`, {
      method: 'POST',
      headers: { 'x-auth-token': authToken }
    });
    const data = await res.json();

    if (data.success) {
      alert(`User "${username}" has been approved!`);
      loadDashboard();
      loadAdminData();
    } else {
      alert(data.error || 'Failed to approve user');
    }
  } catch (err) {
    console.error('Failed to approve user:', err);
    alert('Failed to approve user');
  }
}

async function denyUser(username) {
  if (!confirm(`Are you sure you want to deny and remove user "${username}"?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/admin/users/${username}/deny`, {
      method: 'POST',
      headers: { 'x-auth-token': authToken }
    });
    const data = await res.json();

    if (data.success) {
      alert(`User "${username}" has been denied and removed.`);
      loadDashboard();
    } else {
      alert(data.error || 'Failed to deny user');
    }
  } catch (err) {
    console.error('Failed to deny user:', err);
    alert('Failed to deny user');
  }
}

function setupAdminTabs() {
  const panels = ['dashboard', 'users', 'media', 'cameras', 'comms', 'activity'];

  const hashMigration = {
    pending: 'dashboard',
    stats: 'dashboard',
    motion: 'media',
    chicks: 'media',
    timelapse: 'media',
    chat: 'comms',
    broadcast: 'comms',
    infra: 'cameras'
  };

  document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const panel = tab.dataset.panel;
      location.hash = panel;

      panels.forEach(p => {
        document.getElementById(`admin-${p}`).classList.toggle('hidden', p !== panel);
      });

      if (panel === 'dashboard') loadDashboard();
      if (panel === 'media') loadMediaTab();
      if (panel === 'activity') loadActivityLog();
      if (panel === 'comms') loadBroadcastRecipients();

      if (panel === 'cameras') {
        loadCameraToggles();
        loadInfraData();
        infraRefreshInterval = setInterval(loadInfraData, 60000);
      } else if (infraRefreshInterval) {
        clearInterval(infraRefreshInterval);
        infraRefreshInterval = null;
      }
    };
  });

  // Wire up buttons
  document.getElementById('admin-clear-btn').onclick = clearChat;
  document.getElementById('reject-all-btn').onclick = rejectAllMotion;
  document.getElementById('chick-approve-all-btn').onclick = approveAllChicks;
  document.getElementById('chick-reject-all-btn').onclick = rejectAllChicks;

  // Media sub-tabs
  setupMediaSubTabs();

  // Sortable table headers
  setupSortableTable();

  // Restore tab from URL hash on load (with migration for old hashes)
  const hash = location.hash.replace('#', '');
  const mappedHash = hashMigration[hash] || hash;
  if (mappedHash && panels.includes(mappedHash)) {
    const savedTab = document.querySelector(`.admin-tab[data-panel="${mappedHash}"]`);
    if (savedTab) savedTab.click();
  }
}

function setupMediaSubTabs() {
  document.querySelectorAll('.media-sub-tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.media-sub-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const sub = tab.dataset.sub;
      document.getElementById('media-chicks').classList.toggle('hidden', sub !== 'chicks');
      document.getElementById('media-motion').classList.toggle('hidden', sub !== 'motion');
      document.getElementById('media-timelapse').classList.toggle('hidden', sub !== 'timelapse');
      document.getElementById('media-motion-frames').classList.toggle('hidden', sub !== 'motion-frames');
      document.getElementById('media-capture-stats').classList.toggle('hidden', sub !== 'capture-stats');

      if (sub === 'chicks') loadChickAlbumAdmin();
      if (sub === 'motion') loadMotionPending();
      if (sub === 'timelapse') loadTimelapseFrames();
      if (sub === 'motion-frames') loadMotionCaptureFrames();
      if (sub === 'capture-stats') loadCaptureStats();
    };
  });
}

function loadMediaTab() {
  const activeSub = document.querySelector('.media-sub-tab.active');
  if (activeSub) activeSub.click();
}

async function loadDashboard() {
  const cardsEl = document.getElementById('dashboard-cards');

  try {
    const [pendingRes, statsRes, infraRes] = await Promise.all([
      fetch('/api/admin/pending', { headers: { 'x-auth-token': authToken } }),
      fetch('/api/stats'),
      fetch('/api/admin/infra', { headers: { 'x-auth-token': authToken } }).catch(() => null)
    ]);

    const pending = await pendingRes.json();
    const stats = await statsRes.json();
    const infra = infraRes ? await infraRes.json() : null;

    const uniqueLocations = new Set(stats.visitors.map(v => `${v.city},${v.country}`));
    const pendingCount = pending.length;

    let healthStatus = 'healthy';
    let healthLabel = 'All Systems Healthy';
    if (infra && infra.success && infra.alerts.length > 0) {
      const hasCritical = infra.alerts.some(a => a.level === 'critical');
      healthStatus = hasCritical ? 'critical' : 'warning';
      healthLabel = infra.alerts.map(a => a.message).join(', ');
    }

    let html = `
      <div class="dash-card ${pendingCount > 0 ? 'dash-card-alert' : ''}">
        <div class="dash-card-label">Pending Approvals</div>
        <div class="dash-card-value">${pendingCount}</div>
      </div>
      <div class="dash-card">
        <div class="dash-card-label">Total Views</div>
        <div class="dash-card-value">${stats.totalViews.toLocaleString()}</div>
      </div>
      <div class="dash-card">
        <div class="dash-card-label">Registered Users</div>
        <div class="dash-card-value">${adminUsers.length || '...'}</div>
      </div>
      <div class="dash-card">
        <div class="dash-card-label">Unique Locations</div>
        <div class="dash-card-value">${uniqueLocations.size}</div>
      </div>
      <div class="dash-card dash-card-health ${healthStatus}">
        <div class="dash-card-label">System Health</div>
        <div class="dash-card-value dash-health-dot ${healthStatus}"></div>
        <div class="dash-card-sub">${escapeHtml(healthLabel)}</div>
      </div>
    `;

    if (pendingCount > 0) {
      html += `
        <div class="dash-pending-section">
          <h3>Pending Approval Requests</h3>
          ${pending.map(user => `
            <div class="pending-user">
              <div class="pending-info">
                <strong>${escapeHtml(user.username)}</strong>
                ${user.email ? `<span class="pending-email">${escapeHtml(user.email)}</span>` : ''}
                <span class="pending-date">Registered: ${new Date(user.createdAt).toLocaleString()}</span>
              </div>
              <div class="pending-actions">
                <button class="approve-btn" onclick="approveUser(${jsArg(user.username)})">Approve</button>
                <button class="deny-btn" onclick="denyUser(${jsArg(user.username)})">Deny</button>
              </div>
            </div>
          `).join('')}
        </div>
      `;
    }

    cardsEl.innerHTML = html;
  } catch (err) {
    console.error('Failed to load dashboard:', err);
  }
}

function setupSortableTable() {
  document.querySelectorAll('#users-table th[data-sort]').forEach(th => {
    th.style.cursor = 'pointer';
    th.onclick = () => {
      const col = th.dataset.sort;
      if (userSortCol === col) {
        userSortAsc = !userSortAsc;
      } else {
        userSortCol = col;
        userSortAsc = true;
      }
      renderUsersTable();
    };
  });
}

function getSortValue(user, col) {
  switch (col) {
    case 'username': return user.username.toLowerCase();
    case 'email': return (user.email || '').toLowerCase();
    case 'role': return user.isAdmin ? 'admin' : 'user';
    case 'created': return new Date(user.createdAt).getTime();
    default: return '';
  }
}

function renderUsersTable() {
  const sorted = [...adminUsers].sort((a, b) => {
    const aVal = getSortValue(a, userSortCol);
    const bVal = getSortValue(b, userSortCol);
    let cmp = 0;
    if (typeof aVal === 'number') {
      cmp = aVal - bVal;
    } else {
      cmp = aVal.localeCompare(bVal);
    }
    return userSortAsc ? cmp : -cmp;
  });

  document.querySelectorAll('#users-table th[data-sort]').forEach(th => {
    const labels = { username: 'Username', email: 'Email', role: 'Role', created: 'Created' };
    const arrow = th.dataset.sort === userSortCol ? (userSortAsc ? ' ▲' : ' ▼') : '';
    th.textContent = labels[th.dataset.sort] + arrow;
  });

  const tbody = document.querySelector('#users-table tbody');
  tbody.innerHTML = sorted.map(user => `
    <tr>
      <td>${escapeHtml(user.username)}</td>
      <td>
        <span class="email-display">${user.email ? escapeHtml(user.email) : '<em>none</em>'}</span>
        <button class="edit-email-btn" onclick="editEmail(${jsArg(user.username)}, ${jsArg(user.email || '')})" title="Edit email">&#9998;</button>
      </td>
      <td>${user.isAdmin ? 'Admin' : 'User'}</td>
      <td>${new Date(user.createdAt).toLocaleDateString()}</td>
      <td>
        <div class="action-buttons">
          ${user.isAdmin ? '' : `<button class="admin-btn ${user.ptzAccess ? 'cam-hide-btn' : 'cam-show-btn'}" onclick="togglePtzAccess(${jsArg(user.username)}, ${user.ptzAccess ? 'false' : 'true'})">${user.ptzAccess ? 'Revoke PTZ' : 'Grant PTZ'}</button>`}
          <button class="reset-pwd-btn" onclick="resetPassword(${jsArg(user.username)})">Reset Password</button>
          <button class="delete-user-btn" onclick="deleteUser(${jsArg(user.username)})"
            ${user.username === currentUser ? 'disabled title="Cannot delete yourself"' : ''}>Delete</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function setupChatConnection() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/chat`);

  ws.onopen = () => {
    if (authToken) {
      ws.send(JSON.stringify({ type: 'auth', token: authToken }));
    }
  };

  ws.onclose = () => {
    setTimeout(setupChatConnection, 3000);
  };
}

function clearChat() {
  if (confirm('Are you sure you want to clear all chat messages? This cannot be undone.')) {
    ws.send(JSON.stringify({ type: 'admin_clear_chat' }));
    alert('Chat cleared successfully');
  }
}

async function loadAdminData() {
  try {
    const usersRes = await fetch('/api/admin/users', {
      headers: { 'x-auth-token': authToken }
    });
    const users = await usersRes.json();

    adminUsers = users;
    renderUsersTable();

  } catch (err) {
    console.error('Failed to load admin data:', err);
  }
}

async function editEmail(username, currentEmail) {
  const newEmail = prompt(`Edit email for "${username}":`, currentEmail);
  if (newEmail === null) return;

  try {
    const res = await fetch(`/api/admin/users/${username}/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-auth-token': authToken
      },
      body: JSON.stringify({ email: newEmail.trim() })
    });
    const data = await res.json();

    if (data.success) {
      loadAdminData();
    } else {
      alert(data.error || 'Failed to update email');
    }
  } catch (err) {
    console.error('Failed to update email:', err);
    alert('Failed to update email');
  }
}

async function resetPassword(username) {
  const newPassword = prompt(`Enter new password for "${username}":`);
  if (!newPassword) {
    return;
  }
  if (newPassword.length < 8) {
    alert('Password must be at least 8 characters');
    return;
  }

  try {
    const res = await fetch(`/api/admin/users/${username}/reset-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-auth-token': authToken
      },
      body: JSON.stringify({ newPassword })
    });
    const data = await res.json();

    if (data.success) {
      alert(`Password for "${username}" has been reset successfully.`);
    } else {
      alert(data.error || 'Failed to reset password');
    }
  } catch (err) {
    console.error('Failed to reset password:', err);
    alert('Failed to reset password');
  }
}

async function deleteUser(username) {
  if (!confirm(`Are you sure you want to delete user "${username}"?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/admin/users/${username}`, {
      method: 'DELETE',
      headers: { 'x-auth-token': authToken }
    });
    const data = await res.json();

    if (data.success) {
      loadAdminData();
    } else {
      alert(data.error || 'Failed to delete user');
    }
  } catch (err) {
    console.error('Failed to delete user:', err);
    alert('Failed to delete user');
  }
}

async function loadMotionPending() {
  try {
    const res = await fetch('/api/admin/motion-pending', {
      headers: { 'x-auth-token': authToken }
    });
    const captures = await res.json();
    const list = document.getElementById('motion-pending-list');

    if (captures.length === 0) {
      list.innerHTML = '<p class="no-pending">No pending motion captures</p>';
      return;
    }

    list.innerHTML = captures.map(cap => {
      const date = new Date(cap.created);
      const label = date.toLocaleString();
      return `
        <div class="motion-pending-item" id="motion-${escapeHtml(cap.filename)}">
          <img src="${cap.url}" alt="Motion capture" loading="lazy">
          <div class="motion-pending-info">
            <span>${label}</span>
            <div class="motion-pending-actions">
              <button class="approve-btn" onclick="approveMotion(${jsArg(cap.filename)})">Approve</button>
              <button class="deny-btn" onclick="rejectMotion(${jsArg(cap.filename)})">Reject</button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load motion pending:', err);
  }
}

async function approveMotion(filename) {
  try {
    const res = await fetch(`/api/admin/motion-pending/${filename}/approve`, {
      method: 'POST',
      headers: { 'x-auth-token': authToken }
    });
    if ((await res.json()).success) {
      document.getElementById(`motion-${filename}`).remove();
    }
  } catch (err) {
    console.error('Failed to approve:', err);
  }
}

async function rejectMotion(filename) {
  try {
    const res = await fetch(`/api/admin/motion-pending/${filename}/reject`, {
      method: 'POST',
      headers: { 'x-auth-token': authToken }
    });
    if ((await res.json()).success) {
      document.getElementById(`motion-${filename}`).remove();
    }
  } catch (err) {
    console.error('Failed to reject:', err);
  }
}

async function rejectAllMotion() {
  if (!confirm('Reject all pending motion captures?')) return;

  try {
    const res = await fetch('/api/admin/motion-pending', {
      headers: { 'x-auth-token': authToken }
    });
    const captures = await res.json();

    for (const cap of captures) {
      await fetch(`/api/admin/motion-pending/${cap.filename}/reject`, {
        method: 'POST',
        headers: { 'x-auth-token': authToken }
      });
    }
    loadMotionPending();
  } catch (err) {
    console.error('Failed to reject all:', err);
  }
}

async function clearActivityLog() {
  if (!confirm('Clear all activity logs?')) return;
  try {
    await fetch('/api/admin/activity', {
      method: 'DELETE',
      headers: { 'x-auth-token': authToken }
    });
    loadActivityLog();
  } catch (err) {
    console.error('Failed to clear activity log:', err);
  }
}

async function loadActivityLog() {
  try {
    const res = await fetch('/api/admin/activity', {
      headers: { 'x-auth-token': authToken }
    });
    activityData = await res.json();

    setupActivityFilters();
    renderActivityLog();
  } catch (err) {
    console.error('Failed to load activity log:', err);
  }
}

function setupActivityFilters() {
  const userInput = document.getElementById('activity-filter-user');
  const actionSelect = document.getElementById('activity-filter-action');

  userInput.oninput = renderActivityLog;
  actionSelect.onchange = renderActivityLog;

  const actions = [...new Set(activityData.map(e => e.action))];
  const currentVal = actionSelect.value;
  actionSelect.innerHTML = '<option value="">All Actions</option>' +
    actions.map(a => `<option value="${escapeHtml(a)}">${formatActionLabel(a)}</option>`).join('');
  actionSelect.value = currentVal;
}

function formatActionLabel(action) {
  switch (action) {
    case 'login': return 'Login';
    case 'page_visit': return 'Page Visit';
    default: return action.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
}

function renderActivityLog() {
  const list = document.getElementById('activity-list');
  const userFilter = document.getElementById('activity-filter-user').value.toLowerCase().trim();
  const actionFilter = document.getElementById('activity-filter-action').value;

  if (activityData.length === 0) {
    list.innerHTML = '<p class="no-pending">No activity recorded yet</p>';
    return;
  }

  const filtered = activityData.filter(entry => {
    if (userFilter && !entry.username.toLowerCase().includes(userFilter)) return false;
    if (actionFilter && entry.action !== actionFilter) return false;
    return true;
  });

  list.innerHTML = `<button class="admin-btn" onclick="clearActivityLog()" style="margin-bottom:1rem;">Clear All Logs</button>
    <p class="admin-note" style="margin-bottom:0.5rem;">${filtered.length} of ${activityData.length} entries</p>
    <table id="activity-table">
      <thead>
        <tr><th>Time</th><th>User</th><th>Action</th><th>IP</th><th></th></tr>
      </thead>
      <tbody>
        ${filtered.map((entry) => {
          const origIndex = activityData.indexOf(entry);
          return `
          <tr id="activity-row-${origIndex}">
            <td>${new Date(entry.timestamp).toLocaleString()}</td>
            <td><strong>${escapeHtml(entry.username)}</strong></td>
            <td>${formatAction(entry.action)}</td>
            <td>${entry.details && entry.details.ip ? escapeHtml(entry.details.ip) : '-'}</td>
            <td><button class="deny-btn" onclick="deleteActivityEntry(${origIndex})" title="Delete">&#10005;</button></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

function formatAction(action) {
  switch (action) {
    case 'login': return '<span style="color: var(--forest-green);">Login</span>';
    case 'page_visit': return 'Page Visit';
    default: return escapeHtml(action);
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

  window.location.href = '/';
}

async function loadTimelapseFrames() {
  try {
    const res = await fetch('/api/admin/timelapse-frames', {
      headers: { 'x-auth-token': authToken }
    });
    const frames = await res.json();
    const list = document.getElementById('timelapse-frames-list');

    if (frames.length === 0) {
      list.innerHTML = '<p class="no-pending">No frames captured today yet</p>';
      return;
    }

    const runFrames = frames.filter(f => f.cam === 'run');
    const coopFrames = frames.filter(f => f.cam === 'coop');

    let html = `<p style="margin-bottom:0.5rem;color:var(--wood-brown);">${frames.length} frames today (${runFrames.length} run, ${coopFrames.length} coop)</p>`;

    if (runFrames.length > 0) {
      html += `<h4 style="margin:0.75rem 0 0.5rem;color:var(--forest-green);">Chicken Run</h4>`;
      html += '<div class="timelapse-grid">' + runFrames.map(frame => `
        <div class="timelapse-frame-card" id="frame-${escapeHtml(frame.cam)}-${escapeHtml(frame.filename)}">
          <img src="${frame.url}" alt="${frame.time}" loading="lazy" onclick="openLightbox('${frame.url}','${escapeHtml(frame.cam)}','${escapeHtml(frame.filename)}')">
          <div class="timelapse-frame-info">
            <span>${frame.time}</span>
            <button class="deny-btn" onclick="deleteTimelapseFrame(${jsArg(frame.cam)},${jsArg(frame.filename)})">Delete</button>
          </div>
        </div>
      `).join('') + '</div>';
    }

    if (coopFrames.length > 0) {
      html += `<h4 style="margin:0.75rem 0 0.5rem;color:var(--forest-green);">Chicken Coop</h4>`;
      html += '<div class="timelapse-grid">' + coopFrames.map(frame => `
        <div class="timelapse-frame-card" id="frame-${escapeHtml(frame.cam)}-${escapeHtml(frame.filename)}">
          <img src="${frame.url}" alt="${frame.time}" loading="lazy" onclick="openLightbox('${frame.url}','${escapeHtml(frame.cam)}','${escapeHtml(frame.filename)}')">
          <div class="timelapse-frame-info">
            <span>${frame.time}</span>
            <button class="deny-btn" onclick="deleteTimelapseFrame(${jsArg(frame.cam)},${jsArg(frame.filename)})">Delete</button>
          </div>
        </div>
      `).join('') + '</div>';
    }

    list.innerHTML = html;
  } catch (err) {
    console.error('Failed to load timelapse frames:', err);
  }
}

async function loadMotionCaptureFrames() {
  try {
    const res = await fetch('/api/admin/motion-capture-frames', {
      headers: { 'x-auth-token': authToken }
    });
    const frames = await res.json();
    const list = document.getElementById('motion-capture-frames-list');

    if (frames.length === 0) {
      list.innerHTML = '<p class="no-pending">No motion-capture frames today yet</p>';
      return;
    }

    const runFrames = frames.filter(f => f.cam === 'run');
    const coopFrames = frames.filter(f => f.cam === 'coop');
    const chickFrames = frames.filter(f => f.cam === 'chick');

    let html = `<p style="margin-bottom:0.5rem;color:var(--wood-brown);">${frames.length} frames today (${runFrames.length} run, ${coopFrames.length} coop, ${chickFrames.length} chick)</p>`;

    const renderCamFrames = (camFrames, label) => {
      if (camFrames.length === 0) return '';
      let s = `<h4 style="margin:0.75rem 0 0.5rem;color:var(--forest-green);">${label}</h4>`;
      s += '<div class="timelapse-grid">' + camFrames.map(frame => `
        <div class="timelapse-frame-card" id="mframe-${escapeHtml(frame.cam)}-${escapeHtml(frame.filename)}">
          <img src="${frame.url}" alt="${frame.time}" loading="lazy" onclick="openLightbox('${frame.url}','m-${escapeHtml(frame.cam)}','${escapeHtml(frame.filename)}')">
          <div class="timelapse-frame-info">
            <span>${frame.time}</span>
            <button class="deny-btn" onclick="deleteMotionCaptureFrame(${jsArg(frame.cam)},${jsArg(frame.filename)})">Delete</button>
          </div>
        </div>
      `).join('') + '</div>';
      return s;
    };

    html += renderCamFrames(runFrames, 'Chicken Run');
    html += renderCamFrames(coopFrames, 'Chicken Coop');
    html += renderCamFrames(chickFrames, 'Chick Cam');

    list.innerHTML = html;
  } catch (err) {
    console.error('Failed to load motion capture frames:', err);
  }
}

async function deleteMotionCaptureFrame(cam, filename) {
  try {
    const res = await fetch(`/api/admin/motion-capture-frames/${cam}/${filename}`, {
      method: 'DELETE',
      headers: { 'x-auth-token': authToken }
    });
    if ((await res.json()).success) {
      document.getElementById(`mframe-${cam}-${filename}`).remove();
    }
  } catch (err) {
    console.error('Failed to delete motion capture frame:', err);
  }
}

async function loadCaptureStats() {
  try {
    const res = await fetch('/api/admin/motion-capture-stats', {
      headers: { 'x-auth-token': authToken }
    });
    const data = await res.json();
    const table = document.getElementById('capture-stats-table');
    const dates = Object.keys(data.days || {}).sort((a, b) => b.localeCompare(a));

    if (dates.length === 0) {
      table.innerHTML = '<p class="no-pending">No capture stats logged yet</p>';
      return;
    }

    const fmtCam = (camStats) => {
      if (!camStats) return '0 / 0';
      const total = camStats.captured + camStats.skipped;
      return `${camStats.captured} / ${total}`;
    };

    let html = `
      <table class="admin-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Run (captured/total)</th>
            <th>Coop (captured/total)</th>
            <th>Chick (captured)</th>
          </tr>
        </thead>
        <tbody>
    `;

    html += dates.map(date => {
      const day = data.days[date];
      const chickCaptured = day.chick ? day.chick.captured : 0;
      return `
        <tr>
          <td>${escapeHtml(date)}</td>
          <td>${fmtCam(day.run)}</td>
          <td>${fmtCam(day.coop)}</td>
          <td>${chickCaptured}</td>
        </tr>
      `;
    }).join('');

    html += '</tbody></table>';
    table.innerHTML = html;
  } catch (err) {
    console.error('Failed to load capture stats:', err);
  }
}

async function deleteTimelapseFrame(cam, filename) {
  try {
    const res = await fetch(`/api/admin/timelapse-frames/${cam}/${filename}`, {
      method: 'DELETE',
      headers: { 'x-auth-token': authToken }
    });
    if ((await res.json()).success) {
      document.getElementById(`frame-${cam}-${filename}`).remove();
    }
  } catch (err) {
    console.error('Failed to delete frame:', err);
  }
}

async function deleteActivityEntry(index) {
  try {
    const res = await fetch(`/api/admin/activity/${index}`, {
      method: 'DELETE',
      headers: { 'x-auth-token': authToken }
    });
    if ((await res.json()).success) {
      document.getElementById(`activity-row-${index}`).remove();
    }
  } catch (err) {
    console.error('Failed to delete activity entry:', err);
  }
}

function openLightbox(url, cam, filename) {
  let lb = document.getElementById('timelapse-lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'timelapse-lightbox';
    lb.innerHTML = `
      <div class="lightbox-backdrop" onclick="closeLightbox()"></div>
      <div class="lightbox-content">
        <img id="lightbox-img" src="" alt="Frame">
        <div class="lightbox-actions">
          <button class="approve-btn" onclick="closeLightbox()">Close</button>
          <button class="deny-btn" id="lightbox-delete-btn">Delete Frame</button>
        </div>
      </div>
    `;
    document.body.appendChild(lb);
  }
  document.getElementById('lightbox-img').src = url;
  document.getElementById('lightbox-delete-btn').onclick = () => {
    deleteTimelapseFrame(cam, filename);
    closeLightbox();
  };
  lb.classList.add('active');
}

function closeLightbox() {
  const lb = document.getElementById('timelapse-lightbox');
  if (lb) lb.classList.remove('active');
}

function renderSparkline(values, width, height, color, opts) {
  const nums = values.filter(v => v !== null);
  if (nums.length < 2) return '<span style="color:var(--wood-brown);font-size:0.85rem;">Not enough data</span>';

  const dataMin = Math.min(...nums);
  const dataMax = Math.max(...nums);
  const threshold = opts && opts.threshold;
  const scaleMin = threshold != null ? Math.min(dataMin, 0) : dataMin;
  const scaleMax = threshold != null ? Math.max(dataMax, threshold * 1.2) : dataMax;
  const range = scaleMax - scaleMin || 1;
  const pad = 2;

  const toY = (v) => height - pad - ((v - scaleMin) / range) * (height - pad * 2);

  const points = nums.map((v, i) => {
    const x = (i / (nums.length - 1)) * width;
    return `${x.toFixed(1)},${toY(v).toFixed(1)}`;
  }).join(' ');

  let thresholdLine = '';
  if (threshold != null) {
    const ty = toY(threshold).toFixed(1);
    thresholdLine = `<line x1="0" y1="${ty}" x2="${width}" y2="${ty}" stroke="var(--barn-red)" stroke-width="1" stroke-dasharray="4,3" opacity="0.6"/>`;
  }

  return `<svg width="${width}" height="${height}" class="sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
    ${thresholdLine}
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`;
}

function infraCardStatus(metric, value) {
  switch (metric) {
    case 'ping': return value === null ? 'critical' : (value > 10 ? 'warning' : 'healthy');
    case 'streamAge': return value === null ? 'critical' : (value > 30 ? 'critical' : (value > 15 ? 'warning' : 'healthy'));
    case 'eth0': return value === 'up' ? 'healthy' : 'critical';
    case 'ffmpeg': return value >= 2 ? 'healthy' : (value >= 1 ? 'warning' : 'critical');
    case 'cpu': return value === null ? 'healthy' : (value > 80 ? 'critical' : (value > 50 ? 'warning' : 'healthy'));
    case 'temp': return value === null ? 'healthy' : (value > 82 ? 'critical' : (value > 75 ? 'warning' : 'healthy'));
    case 'network': return 'healthy';
    default: return 'healthy';
  }
}

function worstStatus(...statuses) {
  if (statuses.includes('critical')) return 'critical';
  if (statuses.includes('warning')) return 'warning';
  return 'healthy';
}

function fmtMs(ping) {
  return ping.ok ? `${ping.ms.toFixed(1)} ms` : 'FAIL';
}

function fmtAge(stream) {
  return stream.ok ? `${stream.age}s` : (stream.age === null ? 'NO FILE' : `${stream.age}s (stale)`);
}

function fmtSignal(signal) {
  if (signal === null) return '?';
  return `${signal} dBm`;
}

async function loadInfraData() {
  try {
    const res = await fetch('/api/admin/infra', {
      headers: { 'x-auth-token': authToken }
    });
    const data = await res.json();

    if (!data.success) {
      document.getElementById('infra-alerts').innerHTML = '<div class="infra-alert-banner warning">Failed to load infrastructure data</div>';
      return;
    }

    const alertsEl = document.getElementById('infra-alerts');
    if (data.alerts.length > 0) {
      const hasCritical = data.alerts.some(a => a.level === 'critical');
      const cls = hasCritical ? '' : ' warning';
      alertsEl.innerHTML = `<div class="infra-alert-banner${cls}">
        ${hasCritical ? '<span class="infra-pulse"></span>' : ''}
        <div>${data.alerts.map(a => escapeHtml(a.message)).join('<br>')}</div>
      </div>`;
    } else {
      alertsEl.innerHTML = '<div class="infra-alert-banner healthy">All systems healthy</div>';
    }

    const cardsEl = document.getElementById('infra-cards');
    if (!data.latest) {
      cardsEl.innerHTML = '<p style="color:var(--wood-brown);">No data yet. Waiting for wifi-monitor...</p>';
      document.getElementById('infra-sparklines').innerHTML = '';
      document.getElementById('infra-updated').innerHTML = '';
      return;
    }

    const d = data.latest;

    const networkSignals = [d.wlan1, d.wlan0].filter(w => w.signal !== null);
    const networkStatus = worstStatus(
      d.eth0.state !== 'up' ? 'critical' : 'healthy',
      d.wlan1.signal === null ? 'warning' : 'healthy',
      d.wlan0.signal !== null && d.wlan0.signal < -70 ? 'warning' : 'healthy'
    );

    const cam1Status = worstStatus(
      infraCardStatus('ping', d.pings.cam1.ok ? d.pings.cam1.ms : null),
      infraCardStatus('streamAge', d.streams.stream1.ok ? d.streams.stream1.age : null)
    );

    const cam2Status = worstStatus(
      infraCardStatus('ping', d.pings.cam2.ok ? d.pings.cam2.ms : null),
      infraCardStatus('streamAge', d.streams.stream2.ok ? d.streams.stream2.age : null)
    );

    const cam3Online = d.pings.cam3 && d.pings.cam3.ok;
    const cam3Status = !data.cam3Enabled ? 'disabled' : worstStatus(
      infraCardStatus('ping', d.pings.cam3 && d.pings.cam3.ok ? d.pings.cam3.ms : null),
      infraCardStatus('streamAge', d.streams.stream3 && d.streams.stream3.ok ? d.streams.stream3.age : null)
    );

    const expectedFfmpeg = data.cam3Enabled ? 3 : 2;
    const streamStatus = infraCardStatus('ffmpeg', d.ffmpegCount >= expectedFfmpeg ? expectedFfmpeg : d.ffmpegCount);

    const sys = d.system || {};
    const sysStatus = worstStatus(
      infraCardStatus('cpu', sys.cpu),
      infraCardStatus('temp', sys.temp)
    );
    const memPct = sys.memUsed && sys.memTotal ? ((sys.memUsed / sys.memTotal) * 100).toFixed(0) : null;

    cardsEl.innerHTML = `
      <div class="infra-card ${sysStatus}">
        <div class="infra-card-title">System</div>
        <div class="infra-card-row"><span>CPU</span><span>${sys.cpu !== null ? sys.cpu.toFixed(1) + '%' : '?'}</span></div>
        <div class="infra-card-row"><span>Memory</span><span>${sys.memUsed !== null ? sys.memUsed + ' / ' + sys.memTotal + ' MB (' + memPct + '%)' : '?'}</span></div>
        <div class="infra-card-row"><span>Load (1 min)</span><span>${sys.load !== null ? sys.load.toFixed(2) : '?'}</span></div>
        <div class="infra-card-row"><span>CPU Temp</span><span>${sys.temp !== null ? sys.temp.toFixed(1) + '°C' : '?'}</span></div>
      </div>
      <div class="infra-card ${networkStatus}">
        <div class="infra-card-title">Network</div>
        <div class="infra-card-row"><span>eth0</span><span>${escapeHtml(d.eth0.state)}${d.eth0.speed ? ' @ ' + d.eth0.speed + ' Mbps' : ''}</span></div>
        <div class="infra-card-row"><span>wlan1 (primary)</span><span>${fmtSignal(d.wlan1.signal)}</span></div>
        <div class="infra-card-row"><span>wlan0 (fallback)</span><span>${fmtSignal(d.wlan0.signal)}</span></div>
        <div class="infra-card-row"><span>Wavlink AP</span><span>${fmtMs(d.pings.wavlink)}</span></div>
      </div>
      <div class="infra-card ${cam1Status}">
        <div class="infra-card-title">Chicken Run</div>
        <div class="infra-card-row"><span>Ping</span><span>${fmtMs(d.pings.cam1)}</span></div>
        <div class="infra-card-row"><span>Stream Age</span><span>${fmtAge(d.streams.stream1)}</span></div>
      </div>
      <div class="infra-card ${cam2Status}">
        <div class="infra-card-title">Chicken Coop</div>
        <div class="infra-card-row"><span>Ping</span><span>${fmtMs(d.pings.cam2)}</span></div>
        <div class="infra-card-row"><span>Stream Age</span><span>${fmtAge(d.streams.stream2)}</span></div>
      </div>
      <div class="infra-card ${cam3Status}">
        <div class="infra-card-title">Chick Cam</div>
        ${!data.cam3Enabled
          ? '<div class="infra-card-row"><span>Status</span><span class="infra-offline-badge">Offline</span></div>'
          : `<div class="infra-card-row"><span>Ping</span><span>${d.pings.cam3 ? fmtMs(d.pings.cam3) : '?'}</span></div>
             <div class="infra-card-row"><span>Stream Age</span><span>${d.streams.stream3 ? fmtAge(d.streams.stream3) : '?'}</span></div>`
        }
      </div>
      <div class="infra-card ${streamStatus}">
        <div class="infra-card-title">Streaming</div>
        <div class="infra-card-row"><span>FFmpeg Processes</span><span>${d.ffmpegCount} / ${expectedFfmpeg}</span></div>
        <div class="infra-card-row"><span>Restarts (Run)</span><span>${d.restarts.cam1}</span></div>
        <div class="infra-card-row"><span>Restarts (Coop)</span><span>${d.restarts.cam2}</span></div>
        ${data.cam3Enabled ? `<div class="infra-card-row"><span>Restarts (Chick Cam)</span><span>${d.restarts.cam3}</span></div>` : ''}
      </div>
    `;

    const h = data.history;
    const sparkW = 240;
    const sparkH = 50;

    const fmtSparkVal = (v, unit) => v === null ? '?' : `${typeof v === 'number' && v % 1 !== 0 ? v.toFixed(1) : v}${unit}`;

    const sparklines = [
      { label: 'CPU Usage', values: h.map(e => e.system ? e.system.cpu : null), color: 'var(--forest-green)', unit: '%', threshold: 80, good: 'Under 80% is healthy' },
      { label: 'CPU Temperature', values: h.map(e => e.system ? e.system.temp : null), color: '#c0392b', unit: '°C', threshold: 75, good: 'Under 75°C is healthy' },
      { label: 'Load Average', values: h.map(e => e.system ? e.system.load : null), color: 'var(--wood-brown)', unit: '', threshold: 4, good: 'Under 4 is healthy (4 cores)' },
      { label: 'Run Camera Latency', values: h.map(e => e.pings.cam1.ms), color: 'var(--forest-green)', unit: 'ms', threshold: 10, good: 'Under 10ms is healthy' },
      { label: 'Coop Camera Latency', values: h.map(e => e.pings.cam2.ms), color: 'var(--forest-green)', unit: 'ms', threshold: 10, good: 'Under 10ms is healthy' },
      ...(data.cam3Enabled ? [
        { label: 'Chick Cam Latency', values: h.map(e => e.pings.cam3 ? e.pings.cam3.ms : null), color: 'var(--forest-green)', unit: 'ms', threshold: 10, good: 'Under 10ms is healthy' },
      ] : []),
      { label: 'Run Stream Age', values: h.map(e => e.streams.stream1.age), color: 'var(--wood-brown)', unit: 's', threshold: 30, good: 'Under 30s is healthy' },
      { label: 'Coop Stream Age', values: h.map(e => e.streams.stream2.age), color: 'var(--wood-brown)', unit: 's', threshold: 30, good: 'Under 30s is healthy' },
      ...(data.cam3Enabled ? [
        { label: 'Chick Cam Stream Age', values: h.map(e => e.streams.stream3 ? e.streams.stream3.age : null), color: 'var(--wood-brown)', unit: 's', threshold: 30, good: 'Under 30s is healthy' },
      ] : []),
      { label: 'Fallback WiFi Signal', values: h.map(e => e.wlan0.signal), color: 'var(--wood-brown)', unit: ' dBm', threshold: null, good: 'Closer to 0 is stronger' }
    ];

    document.getElementById('infra-sparklines').innerHTML = sparklines.map(s => {
      const nums = s.values.filter(v => v !== null);
      const current = nums.length > 0 ? nums[nums.length - 1] : null;
      const min = nums.length > 0 ? Math.min(...nums) : null;
      const max = nums.length > 0 ? Math.max(...nums) : null;

      return `<div class="infra-spark-item">
        <div class="infra-spark-header">
          <span class="infra-spark-label">${escapeHtml(s.label)}</span>
          <span class="infra-spark-current">${fmtSparkVal(current, s.unit)}</span>
        </div>
        ${renderSparkline(s.values, sparkW, sparkH, s.color, { threshold: s.threshold })}
        <div class="infra-spark-footer">
          <span class="infra-spark-range">${nums.length > 0 ? `${fmtSparkVal(min, s.unit)} — ${fmtSparkVal(max, s.unit)}` : ''}</span>
          <span class="infra-spark-hint">${s.threshold ? 'Red line = ' + s.threshold + s.unit + ' limit' : escapeHtml(s.good)}</span>
        </div>
      </div>`;
    }).join('');

    document.getElementById('infra-updated').textContent = 'Last updated: ' + new Date().toLocaleTimeString();
  } catch (err) {
    console.error('Failed to load infra data:', err);
  }
}

// --- PTZ Access Management ---

async function togglePtzAccess(username, enabled) {
  try {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(username)}/ptz`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': authToken },
      body: JSON.stringify({ enabled })
    });
    const data = await res.json();
    if (data.success) {
      loadAdminData();
    }
  } catch (err) {
    console.error('Failed to toggle PTZ access:', err);
  }
}

// --- Email Broadcast ---

async function loadBroadcastRecipients() {
  try {
    const res = await fetch('/api/admin/broadcast/recipients', {
      headers: { 'x-auth-token': authToken }
    });
    const recipients = await res.json();
    const el = document.getElementById('broadcast-recipients');
    if (recipients.length === 0) {
      el.innerHTML = '<p class="no-pending">No users have email addresses.</p>';
      document.getElementById('broadcast-send-btn').disabled = true;
      return;
    }
    document.getElementById('broadcast-send-btn').disabled = false;
    el.innerHTML = `<p class="admin-note"><strong>${recipients.length}</strong> recipient${recipients.length === 1 ? '' : 's'}: ${recipients.map(r => escapeHtml(r.username)).join(', ')}</p>`;
  } catch (err) {
    console.error('Failed to load broadcast recipients:', err);
  }
}

async function sendBroadcast() {
  const subject = document.getElementById('broadcast-subject').value.trim();
  const message = document.getElementById('broadcast-message').value.trim();
  if (!subject || !message) {
    alert('Please fill in both subject and message.');
    return;
  }
  if (!confirm(`Send this email to all users with email addresses?`)) return;

  const btn = document.getElementById('broadcast-send-btn');
  btn.disabled = true;
  btn.textContent = 'Sending...';
  const resultEl = document.getElementById('broadcast-result');

  try {
    const res = await fetch('/api/admin/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': authToken },
      body: JSON.stringify({ subject, message })
    });
    const data = await res.json();
    resultEl.classList.remove('hidden');
    if (data.error) {
      resultEl.textContent = data.error;
      resultEl.className = 'broadcast-result broadcast-error';
    } else {
      resultEl.textContent = `Sent to ${data.sent} user${data.sent === 1 ? '' : 's'}${data.failed ? `, ${data.failed} failed` : ''}`;
      resultEl.className = 'broadcast-result broadcast-success';
      document.getElementById('broadcast-subject').value = '';
      document.getElementById('broadcast-message').value = '';
    }
  } catch (err) {
    resultEl.classList.remove('hidden');
    resultEl.textContent = 'Failed to send broadcast';
    resultEl.className = 'broadcast-result broadcast-error';
    console.error('Broadcast failed:', err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send to All';
  }
}

// --- Chick Album ---

async function loadChickAlbumAdmin() {
  await Promise.all([loadChickPending(), loadChickAlbum()]);
}

async function loadChickPending() {
  try {
    const res = await fetch('/api/admin/chick-album/pending', {
      headers: { 'x-auth-token': authToken }
    });
    const captures = await res.json();
    const list = document.getElementById('chick-pending-list');

    if (captures.length === 0) {
      list.innerHTML = '<p class="no-pending">No pending chick captures</p>';
      return;
    }

    list.innerHTML = captures.map(cap => {
      const date = new Date(cap.created);
      const label = date.toLocaleString();
      return `
        <div class="motion-pending-item" id="chick-${escapeHtml(cap.filename)}">
          <img src="${cap.url}" alt="Chick capture" loading="lazy">
          <div class="motion-pending-info">
            <span>${label}</span>
            <div class="motion-pending-actions">
              <button class="approve-btn" onclick="approveChick(${jsArg(cap.filename)})">Approve</button>
              <button class="deny-btn" onclick="rejectChick(${jsArg(cap.filename)})">Reject</button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load chick pending:', err);
  }
}

async function loadChickAlbum() {
  try {
    const res = await fetch('/api/chick-album');
    const captures = await res.json();
    const list = document.getElementById('chick-album-list');
    document.getElementById('chick-album-count').textContent = captures.length;

    if (captures.length === 0) {
      list.innerHTML = '<p class="no-pending">No approved photos yet</p>';
      return;
    }

    list.innerHTML = '<div class="timelapse-grid">' + captures.map(cap => {
      const date = new Date(cap.created);
      const label = date.toLocaleString();
      return `
        <div class="timelapse-frame-card" id="album-${escapeHtml(cap.filename)}">
          <img src="${cap.url}" alt="Chick ${label}" loading="lazy" onclick="window.open('${cap.url}','_blank')">
          <div class="timelapse-frame-info">
            <span>${label}</span>
            <button class="deny-btn" onclick="deleteChickAlbum(${jsArg(cap.filename)})">Delete</button>
          </div>
        </div>
      `;
    }).join('') + '</div>';
  } catch (err) {
    console.error('Failed to load chick album:', err);
  }
}

async function approveChick(filename) {
  try {
    const res = await fetch(`/api/admin/chick-album/pending/${filename}/approve`, {
      method: 'POST',
      headers: { 'x-auth-token': authToken }
    });
    if ((await res.json()).success) {
      const el = document.getElementById(`chick-${filename}`);
      if (el) el.remove();
      loadChickAlbum();
    }
  } catch (err) {
    console.error('Failed to approve chick:', err);
  }
}

async function rejectChick(filename) {
  try {
    const res = await fetch(`/api/admin/chick-album/pending/${filename}/reject`, {
      method: 'POST',
      headers: { 'x-auth-token': authToken }
    });
    if ((await res.json()).success) {
      const el = document.getElementById(`chick-${filename}`);
      if (el) el.remove();
    }
  } catch (err) {
    console.error('Failed to reject chick:', err);
  }
}

async function approveAllChicks() {
  if (!confirm('Approve all pending chick captures into the album?')) return;
  try {
    const res = await fetch('/api/admin/chick-album/approve-all', {
      method: 'POST',
      headers: { 'x-auth-token': authToken }
    });
    const data = await res.json();
    if (data.success) {
      loadChickAlbumAdmin();
    }
  } catch (err) {
    console.error('Failed to approve all chicks:', err);
  }
}

async function rejectAllChicks() {
  if (!confirm('Reject all pending chick captures?')) return;
  try {
    const res = await fetch('/api/admin/chick-album/reject-all', {
      method: 'POST',
      headers: { 'x-auth-token': authToken }
    });
    const data = await res.json();
    if (data.success) {
      loadChickPending();
    }
  } catch (err) {
    console.error('Failed to reject all chicks:', err);
  }
}

async function deleteChickAlbum(filename) {
  try {
    const res = await fetch(`/api/admin/chick-album/${filename}`, {
      method: 'DELETE',
      headers: { 'x-auth-token': authToken }
    });
    if ((await res.json()).success) {
      const el = document.getElementById(`album-${filename}`);
      if (el) el.remove();
      const count = document.getElementById('chick-album-count');
      count.textContent = Math.max(0, parseInt(count.textContent) - 1);
    }
  } catch (err) {
    console.error('Failed to delete chick album photo:', err);
  }
}

// --- Camera Visibility Toggles ---

async function loadCameraToggles() {
  try {
    const res = await fetch('/api/admin/cameras', {
      headers: { 'x-auth-token': authToken }
    });
    const cameras = await res.json();
    const list = document.getElementById('camera-toggle-list');

    if (cameras.length === 0) {
      list.innerHTML = '<p class="no-pending">No cameras configured</p>';
      return;
    }

    list.innerHTML = cameras.map(cam => `
      <div class="camera-toggle-row ${cam.enabled ? '' : 'cam-disabled'}" id="cam-row-${escapeHtml(cam.id)}">
        <div class="camera-toggle-info">
          <strong>${escapeHtml(cam.name)}</strong>
          <span class="camera-toggle-status ${!cam.enabled ? 'status-offline' : (cam.hidden ? 'status-hidden' : 'status-live')}">
            ${!cam.enabled ? 'Disabled' : (cam.hidden ? 'Hidden from public' : 'Live for everyone')}
          </span>
        </div>
        <div class="camera-toggle-actions">
          <button class="admin-btn ${cam.enabled ? 'cam-disable-btn' : 'cam-enable-btn'}" onclick="toggleCameraEnabled(${jsArg(cam.id)})">
            ${cam.enabled ? 'Disable' : 'Enable'}
          </button>
          ${cam.enabled ? `<button class="admin-btn ${cam.hidden ? 'cam-show-btn' : 'cam-hide-btn'}" onclick="toggleCamera(${jsArg(cam.id)})">
            ${cam.hidden ? 'Make Public' : 'Hide'}
          </button>` : ''}
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to load camera toggles:', err);
  }
}

async function toggleCameraEnabled(camId) {
  try {
    const res = await fetch(`/api/admin/cameras/${encodeURIComponent(camId)}/enable`, {
      method: 'POST',
      headers: { 'x-auth-token': authToken }
    });
    const data = await res.json();
    if (data.id) {
      loadCameraToggles();
    }
  } catch (err) {
    console.error('Failed to toggle camera enabled:', err);
  }
}

async function toggleCamera(camId) {
  try {
    const res = await fetch(`/api/admin/cameras/${encodeURIComponent(camId)}/toggle`, {
      method: 'POST',
      headers: { 'x-auth-token': authToken }
    });
    const data = await res.json();
    if (data.id) {
      loadCameraToggles();
    }
  } catch (err) {
    console.error('Failed to toggle camera:', err);
  }
}

init();
