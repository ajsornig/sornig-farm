const http = require('http');
const crypto = require('crypto');

const ONVIF_PORT = 8000;

const OP_TO_VELOCITY = {
  Left:      { x: -1,  y: 0   },
  Right:     { x: 1,   y: 0   },
  Up:        { x: 0,   y: 1   },
  Down:      { x: 0,   y: -1  },
  LeftUp:    { x: -0.7, y: 0.7  },
  LeftDown:  { x: -0.7, y: -0.7 },
  RightUp:   { x: 0.7,  y: 0.7  },
  RightDown: { x: 0.7,  y: -0.7 },
};

const VALID_OPS = [...Object.keys(OP_TO_VELOCITY), 'ZoomInc', 'ZoomDec', 'Stop'];

// Escape values interpolated into the SOAP/XML envelope so a preset name can't
// inject markup into the request.
function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function makeWsseHeader(username, password) {
  const nonce = crypto.randomBytes(16);
  const created = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const raw = Buffer.concat([nonce, Buffer.from(created), Buffer.from(password)]);
  const digest = crypto.createHash('sha1').update(raw).digest('base64');

  return `<wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"><wsse:UsernameToken><wsse:Username>${username}</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password><wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</wsse:Nonce><wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security>`;
}

function soapRequest(ip, service, body, username, password) {
  const wsseHeader = makeWsseHeader(username, password);
  const envelope = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">${wsseHeader ? `<s:Header>${wsseHeader}</s:Header>` : ''}<s:Body>${body}</s:Body></s:Envelope>`;

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: ip,
      port: ONVIF_PORT,
      path: `/onvif/${service}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/soap+xml', 'Content-Length': Buffer.byteLength(envelope) },
      timeout: 5000
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (data.includes('Fault')) {
          const reason = data.match(/<SOAP-ENV:Text[^>]*>([^<]+)/);
          reject(new Error(reason ? reason[1] : 'ONVIF SOAP fault'));
        } else {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('ONVIF request timeout')); });
    req.write(envelope);
    req.end();
  });
}

const profileCache = new Map();

async function getProfileToken(ip, username, password) {
  if (profileCache.has(ip)) return profileCache.get(ip);

  const body = '<GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>';
  const resp = await soapRequest(ip, 'media_service', body, username, password);
  const match = resp.match(/Profiles[^>]*token="([^"]+)"/);
  const token = match ? match[1] : '000';
  profileCache.set(ip, token);
  return token;
}

async function sendPtzCommand(cameraConfig, op, speed = 0.5) {
  if (!VALID_OPS.includes(op)) {
    throw new Error(`Invalid PTZ operation: ${op}`);
  }

  const { ip, username, password } = cameraConfig.ptz;
  const profileToken = await getProfileToken(ip, username, password);

  if (op === 'Stop') {
    const body = `<Stop xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>${profileToken}</ProfileToken><PanTilt>true</PanTilt></Stop>`;
    await soapRequest(ip, 'ptz_service', body, username, password);
    return { success: true };
  }

  const vel = OP_TO_VELOCITY[op];
  if (vel) {
    const x = vel.x * speed;
    const y = vel.y * speed;
    const body = `<ContinuousMove xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>${profileToken}</ProfileToken><Velocity><tt:PanTilt x="${x}" y="${y}"/></Velocity></ContinuousMove>`;
    await soapRequest(ip, 'ptz_service', body, username, password);
    return { success: true };
  }

  return { success: false, error: 'Unsupported operation' };
}

async function getPresets(cameraConfig) {
  const { ip, username, password } = cameraConfig.ptz;
  const profileToken = await getProfileToken(ip, username, password);

  const body = `<GetPresets xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>${profileToken}</ProfileToken></GetPresets>`;
  const resp = await soapRequest(ip, 'ptz_service', body, username, password);

  const presets = [];
  const re = /<tptz:Preset[^>]*token="([^"]+)"[^>]*>.*?<tt:Name>([^<]+)<\/tt:Name>/gs;
  let m;
  while ((m = re.exec(resp)) !== null) {
    presets.push({ token: m[1], name: m[2] });
  }
  return presets;
}

async function gotoPreset(cameraConfig, presetToken) {
  const { ip, username, password } = cameraConfig.ptz;
  const profileToken = await getProfileToken(ip, username, password);

  const body = `<GotoPreset xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>${profileToken}</ProfileToken><PresetToken>${presetToken}</PresetToken></GotoPreset>`;
  await soapRequest(ip, 'ptz_service', body, username, password);
  return { success: true };
}

async function setPreset(cameraConfig, name) {
  const { ip, username, password } = cameraConfig.ptz;
  const profileToken = await getProfileToken(ip, username, password);

  const body = `<SetPreset xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>${profileToken}</ProfileToken><PresetName>${xmlEscape(name)}</PresetName></SetPreset>`;
  const resp = await soapRequest(ip, 'ptz_service', body, username, password);
  const tokenMatch = resp.match(/PresetToken>([^<]+)</);
  return { success: true, token: tokenMatch ? tokenMatch[1] : null };
}

async function removePreset(cameraConfig, presetToken) {
  const { ip, username, password } = cameraConfig.ptz;
  const profileToken = await getProfileToken(ip, username, password);

  const body = `<RemovePreset xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>${profileToken}</ProfileToken><PresetToken>${presetToken}</PresetToken></RemovePreset>`;
  await soapRequest(ip, 'ptz_service', body, username, password);
  return { success: true };
}

module.exports = { sendPtzCommand, getPresets, gotoPreset, setPreset, removePreset, VALID_OPS };
