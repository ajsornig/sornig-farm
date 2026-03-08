let authToken = localStorage.getItem('authToken');
let currentUser = null;
let isAdmin = false;
let ws = null;

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
}

function setupAdminTabs() {
  document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const panel = tab.dataset.panel;
      document.getElementById('admin-users').classList.toggle('hidden', panel !== 'users');
      document.getElementById('admin-stats').classList.toggle('hidden', panel !== 'stats');
      document.getElementById('admin-chat').classList.toggle('hidden', panel !== 'chat');
    };
  });

  document.getElementById('admin-clear-btn').onclick = clearChat;
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
        <td>${user.username}</td>
        <td>${user.isAdmin ? 'Admin' : 'User'}</td>
        <td>${new Date(user.createdAt).toLocaleDateString()}</td>
        <td>
          <button class="delete-user-btn" onclick="deleteUser('${user.username}')"
            ${user.username === currentUser ? 'disabled title="Cannot delete yourself"' : ''}>
            Delete
          </button>
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

init();
