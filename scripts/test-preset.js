const { getPresets, gotoPreset } = require('../server/ptz');
const config = require('../config.json');

const cam = config.cameras.find(c => c.id === 'cam3');

async function setPreset(cameraConfig, name) {
  const { ip, username, password } = cameraConfig.ptz;
  const http = require('http');
  const crypto = require('crypto');

  function makeWsseHeader(user, pass) {
    const nonce = crypto.randomBytes(16);
    const created = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const raw = Buffer.concat([nonce, Buffer.from(created), Buffer.from(pass)]);
    const digest = crypto.createHash('sha1').update(raw).digest('base64');
    return `<wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"><wsse:UsernameToken><wsse:Username>${user}</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password><wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</wsse:Nonce><wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security>`;
  }

  function soap(svcIp, service, body, user, pass) {
    const wsseHeader = makeWsseHeader(user, pass);
    const envelope = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">${wsseHeader ? `<s:Header>${wsseHeader}</s:Header>` : ''}<s:Body>${body}</s:Body></s:Envelope>`;
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: svcIp, port: 8000, path: `/onvif/ptz_service`,
        method: 'POST',
        headers: { 'Content-Type': 'application/soap+xml', 'Content-Length': Buffer.byteLength(envelope) },
        timeout: 5000
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (data.includes('Fault')) {
            const reason = data.match(/<SOAP-ENV:Text[^>]*>([^<]+)/);
            reject(new Error(reason ? reason[1] : 'ONVIF SOAP fault: ' + data.substring(0, 200)));
          } else {
            resolve(data);
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(envelope);
      req.end();
    });
  }

  // Get profile token
  const mediaBody = '<GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>';
  const mediaResp = await soap(ip, 'media_service', mediaBody, username, password).catch(() => null);
  let profileToken = '000';
  if (mediaResp) {
    const match = mediaResp.match(/Profiles[^>]*token="([^"]+)"/);
    if (match) profileToken = match[1];
  }

  // SetPreset
  const body = `<SetPreset xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>${profileToken}</ProfileToken><PresetName>${name}</PresetName></SetPreset>`;
  const resp = await soap(ip, 'ptz_service', body, username, password);
  console.log('SetPreset response:', resp.substring(0, 500));
  return resp;
}

async function main() {
  const action = process.argv[2] || 'save';

  if (action === 'save') {
    console.log('Saving current position as "Home"...');
    await setPreset(cam, 'Home');
    console.log('\nVerifying presets:');
    const presets = await getPresets(cam);
    console.log(JSON.stringify(presets, null, 2));
  } else if (action === 'goto') {
    const id = parseInt(process.argv[3] || '1');
    console.log(`Going to preset ${id}...`);
    const result = await gotoPreset(cam, id);
    console.log('Result:', result);
  } else if (action === 'list') {
    const presets = await getPresets(cam);
    console.log('Presets:', JSON.stringify(presets, null, 2));
  }
}

main().catch(e => console.error('ERROR:', e.message));
