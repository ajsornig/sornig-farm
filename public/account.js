let authToken = localStorage.getItem('authToken');
let currentUser = null;

async function init() {
  await checkAuth();
}

async function checkAuth() {
  document.getElementById('account-loading').classList.remove('hidden');
  document.getElementById('account-unauthorized').classList.add('hidden');
  document.getElementById('account-panel').classList.add('hidden');

  if (!authToken) {
    showUnauthorized();
    return;
  }

  try {
    const res = await fetch('/api/me', {
      headers: { 'x-auth-token': authToken }
    });
    const data = await res.json();

    if (data.loggedIn) {
      currentUser = data.username;
      showAccountPanel(data);
    } else {
      showUnauthorized();
    }
  } catch (err) {
    console.error('Auth check failed:', err);
    showUnauthorized();
  }
}

function showUnauthorized() {
  document.getElementById('account-loading').classList.add('hidden');
  document.getElementById('account-unauthorized').classList.remove('hidden');
  document.getElementById('account-panel').classList.add('hidden');
}

function showAccountPanel(data) {
  document.getElementById('account-loading').classList.add('hidden');
  document.getElementById('account-unauthorized').classList.add('hidden');
  document.getElementById('account-panel').classList.remove('hidden');

  document.getElementById('user-status').textContent = `Welcome, ${data.username}`;
  document.getElementById('logout-btn').classList.remove('hidden');
  document.getElementById('logout-btn').onclick = doLogout;

  document.getElementById('account-username').textContent = data.username;
  document.getElementById('account-email').textContent = data.email || 'Not set';
  document.getElementById('account-created').textContent = data.createdAt
    ? new Date(data.createdAt).toLocaleDateString()
    : 'Unknown';
}

async function editMyEmail() {
  const newEmail = prompt('Enter your email address:', document.getElementById('account-email').textContent === 'Not set' ? '' : document.getElementById('account-email').textContent);
  if (newEmail === null) return;

  try {
    const res = await fetch('/api/account/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-auth-token': authToken
      },
      body: JSON.stringify({ email: newEmail.trim() })
    });
    const data = await res.json();

    if (data.success) {
      document.getElementById('account-email').textContent = newEmail.trim() || 'Not set';
      alert('Email updated!');
    } else {
      alert(data.error || 'Failed to update email');
    }
  } catch (err) {
    console.error('Failed to update email:', err);
    alert('Failed to update email');
  }
}

async function changePassword(e) {
  e.preventDefault();
  const msgEl = document.getElementById('password-message');
  const currentPassword = document.getElementById('current-password').value;
  const newPassword = document.getElementById('new-password').value;
  const confirmPassword = document.getElementById('confirm-password').value;

  if (newPassword !== confirmPassword) {
    msgEl.textContent = 'New passwords do not match';
    msgEl.className = 'form-error';
    msgEl.classList.remove('hidden');
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

    if (data.success) {
      msgEl.textContent = 'Password updated successfully!';
      msgEl.className = 'form-success';
      msgEl.classList.remove('hidden');
      document.getElementById('change-password-form').reset();
    } else {
      msgEl.textContent = data.error || 'Failed to update password';
      msgEl.className = 'form-error';
      msgEl.classList.remove('hidden');
    }
  } catch (err) {
    msgEl.textContent = 'Failed to update password';
    msgEl.className = 'form-error';
    msgEl.classList.remove('hidden');
  }
}

async function deleteMyAccount() {
  const confirm1 = confirm('Are you sure you want to delete your account? This cannot be undone.');
  if (!confirm1) return;

  const confirm2 = prompt('Type your username to confirm deletion:');
  if (confirm2 !== currentUser) {
    alert('Username did not match. Account not deleted.');
    return;
  }

  try {
    const res = await fetch('/api/account', {
      method: 'DELETE',
      headers: { 'x-auth-token': authToken }
    });
    const data = await res.json();

    if (data.success) {
      localStorage.removeItem('authToken');
      alert('Your account has been deleted.');
      window.location.href = '/';
    } else {
      alert(data.error || 'Failed to delete account');
    }
  } catch (err) {
    alert('Failed to delete account');
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
  window.location.href = '/';
}

init();
