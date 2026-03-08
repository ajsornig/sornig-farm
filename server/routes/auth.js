const config = require('../../config.json');

const SESSION_COOKIE = 'chicken_session';

function authMiddleware(req, res, next) {
  if (!config.authEnabled) {
    return next();
  }

  if (req.path === '/login' || req.path === '/api/login') {
    return next();
  }

  const session = req.cookies[SESSION_COOKIE];
  if (session === 'authenticated') {
    return next();
  }

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.redirect('/login');
}

function loginHandler(req, res) {
  const { password } = req.body;

  if (password === config.password) {
    res.cookie(SESSION_COOKIE, 'authenticated', {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
}

function logoutHandler(req, res) {
  res.clearCookie(SESSION_COOKIE);
  res.json({ success: true });
}

module.exports = {
  authMiddleware,
  loginHandler,
  logoutHandler
};
