const http = require('http');

function reolinkRequest(cameraConfig, cmd, params) {
  const { ip, username, password, httpPort } = cameraConfig.ptz;
  const port = httpPort || 80;
  const body = JSON.stringify([{ cmd, action: 0, param: params }]);

  // Credentials are URL-encoded so a password containing &, +, #, or a space
  // can't corrupt the query or silently break auth. NOTE: the Reolink CGI still
  // takes user/password as query params (its documented scheme), so they can
  // appear in the camera's own access log. This traffic is LAN-only over the
  // camera network; moving to the token-login flow (cmd=Login → token) is the
  // full fix but must be validated against the camera firmware before shipping.
  const auth = `user=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: ip,
      port,
      path: `/api.cgi?cmd=${encodeURIComponent(cmd)}&${auth}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed[0].code !== 0) {
            reject(new Error(parsed[0].error?.detail || 'Reolink API error'));
          } else {
            resolve(parsed[0].value);
          }
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
