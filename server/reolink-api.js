const http = require('http');

// Reolink HTTP API client using token authentication. Credentials are sent ONLY
// in the Login request body (never in a URL/query string), so they can't leak
// into the camera's access logs. Login returns a token with a lease; we cache it
// per camera IP, reuse it until shortly before expiry, and re-login on demand.
const tokenCache = new Map(); // ip -> { token, expiresAt }

function rawRequest(ip, port, cmd, query, bodyObj) {
  const body = JSON.stringify(bodyObj);
  const qs = new URLSearchParams({ cmd, ...query }).toString();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: ip,
      port,
      path: `/api.cgi?${qs}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed[0]);
        } catch (err) {
          reject(new Error('Invalid response from camera'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Reolink API timeout')); });
    req.write(body);
    req.end();
  });
}

async function login(cameraConfig) {
  const { ip, username, password, httpPort } = cameraConfig.ptz;
  const port = httpPort || 80;
  const resp = await rawRequest(ip, port, 'Login', {}, [
    { cmd: 'Login', action: 0, param: { User: { userName: username, password } } }
  ]);
  if (!resp || resp.code !== 0 || !resp.value || !resp.value.Token) {
    throw new Error(resp && resp.error ? (resp.error.detail || 'Reolink login failed') : 'Reolink login failed');
  }
  const { name, leaseTime } = resp.value.Token;
  // Renew a minute early to avoid using a token that expires mid-request.
  const ttl = Math.max(60, (leaseTime || 3600) - 60) * 1000;
  tokenCache.set(ip, { token: name, expiresAt: Date.now() + ttl });
  return name;
}

async function getToken(cameraConfig) {
  const ip = cameraConfig.ptz.ip;
  const cached = tokenCache.get(ip);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  return login(cameraConfig);
}

async function reolinkRequest(cameraConfig, cmd, params, _retried = false) {
  const { ip, httpPort } = cameraConfig.ptz;
  const port = httpPort || 80;
  const token = await getToken(cameraConfig);

  const resp = await rawRequest(ip, port, cmd, { token }, [{ cmd, action: 0, param: params }]);

  if (!resp || resp.code !== 0) {
    // A stale/expired token surfaces as an API error — drop it and retry once
    // with a fresh login before giving up.
    if (!_retried) {
      tokenCache.delete(ip);
      return reolinkRequest(cameraConfig, cmd, params, true);
    }
    throw new Error((resp && resp.error && resp.error.detail) || 'Reolink API error');
  }
  return resp.value;
}

async function getAiConfig(cameraConfig) {
  return reolinkRequest(cameraConfig, 'GetAiCfg', { channel: 0 });
}

async function setAiTrack(cameraConfig, enabled) {
  return reolinkRequest(cameraConfig, 'SetAiCfg', { channel: 0, aiTrack: enabled ? 1 : 0, bSmartTrack: enabled ? 1 : 0 });
}

async function setTrackTypes(cameraConfig, types) {
  return reolinkRequest(cameraConfig, 'SetAiCfg', {
    channel: 0,
    trackType: {
      people: types.people ? 1 : 0,
      dog_cat: types.dogCat ? 1 : 0,
      vehicle: types.vehicle ? 1 : 0,
      face: types.face ? 1 : 0
    }
  });
}

async function setTrackBackTimes(cameraConfig, { stopBack, disappearBack }) {
  const params = { channel: 0 };
  if (stopBack !== undefined) params.aiStopBackTime = stopBack;
  if (disappearBack !== undefined) params.aiDisappearBackTime = disappearBack;
  return reolinkRequest(cameraConfig, 'SetAiCfg', params);
}

async function getPtzGuard(cameraConfig) {
  const result = await reolinkRequest(cameraConfig, 'GetPtzGuard', { channel: 0 });
  return result.PtzGuard;
}

async function setPtzGuard(cameraConfig, { enable, timeout }) {
  return reolinkRequest(cameraConfig, 'SetPtzGuard', {
    PtzGuard: { benable: enable ? 1 : 0, timeout: timeout || 60, channel: 0 }
  });
}

module.exports = { getAiConfig, setAiTrack, setTrackTypes, setTrackBackTimes, getPtzGuard, setPtzGuard };
