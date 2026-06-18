let authToken = localStorage.getItem('authToken');
let currentUser = null;
let isAdmin = false;
let ws = null;

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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
  loadPendingUsers();
  loadAdminData();
}

async function loadPendingUsers() {
  try {
    const res = await fetch('/api/admin/pending', {
      headers: { 'x-auth-token': authToken }
    });
    const pending = await res.json();

    const list = document.getElementById('pending-list');
    if (pending.length === 0) {
      list.innerHTML = '<p class="no-pending">No pending approval requests</p>';
      return;
    }

    list.innerHTML = pending.map(user => `
      <div class="pending-user">
        <div class="pending-info">
          <strong>${escapeHtml(user.username)}</strong>
          ${user.email ? `<span class="pending-email">${escapeHtml(user.email)}</span>` : ''}
          <span class="pending-date">Registered: ${new Date(user.createdAt).toLocaleString()}</span>
        </div>
        <div class="pending-actions">
          <button class="approve-btn" onclick="approveUser('${escapeHtml(user.username)}')">Approve</button>
          <button class="deny-btn" onclick="denyUser('${escapeHtml(user.username)}')">Deny</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to load pending users:', err);
  }
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
      loadPendingUsers();
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
      loadPendingUsers();
    } else {
      alert(data.error || 'Failed to deny user');
    }
  } catch (err) {
    console.error('Failed to deny user:', err);
    alert('Failed to deny user');
  }
}

function setupAdminTabs() {
  document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const panel = tab.dataset.panel;
      document.getElementById('admin-pending').classList.toggle('hidden', panel !== 'pending');
      document.getElementById('admin-users').classList.toggle('hidden', panel !== 'users');
      document.getElementById('admin-motion').classList.toggle('hidden', panel !== 'motion');
      document.getElementById('admin-timelapse').classList.toggle('hidden', panel !== 'timelapse');
      document.getElementById('admin-activity').classList.toggle('hidden', panel !== 'activity');
      document.getElementById('admin-stats').classList.toggle('hidden', panel !== 'stats');
      document.getElementById('admin-chat').classList.toggle('hidden', panel !== 'chat');

      if (panel === 'activity') loadActivityLog();
      if (panel === 'motion') loadMotionPending();
      if (panel === 'timelapse') loadTimelapseFrames();
    };
  });

  document.getElementById('admin-clear-btn').onclick = clearChat;
  document.getElementById('reject-all-btn').onclick = rejectAllMotion;
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

    const tbody = document.querySelector('#users-table tbody');
    tbody.innerHTML = users.map(user => `
      <tr>
        <td>${escapeHtml(user.username)}</td>
        <td>
          <span class="email-display">${user.email ? escapeHtml(user.email) : '<em>none</em>'}</span>
          <button class="edit-email-btn" onclick="editEmail('${escapeHtml(user.username)}', '${escapeHtml(user.email || '')}')" title="Edit email">&#9998;</button>
        </td>
        <td>${user.isAdmin ? 'Admin' : 'User'}</td>
        <td>${new Date(user.createdAt).toLocaleDateString()}</td>
        <td>
          <div class="action-buttons">
            <button class="reset-pwd-btn" onclick="resetPassword('${escapeHtml(user.username)}')">
              Reset Password
            </button>
            <button class="delete-user-btn" onclick="deleteUser('${escapeHtml(user.username)}')"
              ${user.username === currentUser ? 'disabled title="Cannot delete yourself"' : ''}>
              Delete
            </button>
          </div>
        </td>
      </tr>
    `).join('');

    document.getElementById('admin-user-count').textContent = users.length;

    const statsRes = await fetch('/api/stats');
    const stats = await statsRes.json();

    document.getElementById('admin-total-views').textContent = stats.totalViews.toLocaleString();

    const uniqueLocations = new Set(stats.visitors.map(v => `${v.city},${v.country}`));
    document.getElementById('admin-locations').textContent = uniqueLocations.size;

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
  if (newPassword.length < 4) {
    alert('Password must be at least 4 characters');
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
              <button class="approve-btn" onclick="approveMotion('${escapeHtml(cap.filename)}')">Approve</button>
              <button class="deny-btn" onclick="rejectMotion('${escapeHtml(cap.filename)}')">Reject</button>
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
    const activity = await res.json();

    const list = document.getElementById('activity-list');
    if (activity.length === 0) {
      list.innerHTML = '<p class="no-pending">No activity recorded yet</p>';
      return;
    }

    list.innerHTML = `<button class="admin-btn" onclick="clearActivityLog()" style="margin-bottom:1rem;">Clear All Logs</button>
    <table id="activity-table">
      <thead>
        <tr><th>Time</th><th>User</th><th>Action</th><th>IP</th></tr>
      </thead>
      <tbody>
        ${activity.map(entry => `
          <tr>
            <td>${new Date(entry.timestamp).toLocaleString()}</td>
            <td><strong>${escapeHtml(entry.username)}</strong></td>
            <td>${formatAction(entry.action)}</td>
            <td>${entry.details && entry.details.ip ? escapeHtml(entry.details.ip) : '-'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
  } catch (err) {
    console.error('Failed to load activity log:', err);
  }
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

    list.innerHTML = `<p style="margin-bottom:0.5rem;color:var(--wood-brown);">${frames.length} frames today</p>` +
      '<div class="timelapse-grid">' + frames.map(frame => `
        <div class="timelapse-frame-card" id="frame-${escapeHtml(frame.filename)}">
          <img src="${frame.url}" alt="${frame.time}" loading="lazy">
          <div class="timelapse-frame-info">
            <span>${frame.time}</span>
            <button class="deny-btn" onclick="deleteTimelapseFrame('${escapeHtml(frame.filename)}')">Delete</button>
          </div>
        </div>
      `).join('') + '</div>';
  } catch (err) {
    console.error('Failed to load timelapse frames:', err);
  }
}

async function deleteTimelapseFrame(filename) {
  try {
    const res = await fetch(`/api/admin/timelapse-frames/${filename}`, {
      method: 'DELETE',
      headers: { 'x-auth-token': authToken }
    });
    if ((await res.json()).success) {
      document.getElementById(`frame-${filename}`).remove();
    }
  } catch (err) {
    console.error('Failed to delete frame:', err);
  }
}

init();
