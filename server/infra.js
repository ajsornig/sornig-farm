const fs = require('fs');
const config = require('../config.json');

const INFRA_HISTORY_COUNT = 60;

// Read only the tail of a (potentially large, unrotated) log so admin polls don't
// load an ever-growing file in full. Returns whole lines (drops a leading partial).
function readLogTail(filePath, maxBytes = 256 * 1024) {
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const len = stat.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl !== -1) text = text.slice(nl + 1);
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

function parseInfraLine(line) {
  const parts = line.split(' | ');
  if (parts.length < 7) return null;

  const timestamp = parts[0].trim();

  const eth0Match = parts[1].match(/eth0=(\w+)@(\d+|\?)Mbps/);
  const eth0 = eth0Match
    ? { state: eth0Match[1], speed: eth0Match[2] === '?' ? null : Number(eth0Match[2]) }
    : { state: 'UNKNOWN', speed: null };

  const wlan0Match = parts[2].match(/wlan0=(-?\d+|\?)dBm/);
  const wlan0 = { signal: wlan0Match && wlan0Match[1] !== '?' ? Number(wlan0Match[1]) : null };

  let wlan1 = { signal: null };
  let pingIdx = 3;

  if (parts.length >= 8) {
    const wlan1Match = parts[3].match(/wlan1=(-?\d+|\?)dBm/);
    wlan1 = { signal: wlan1Match && wlan1Match[1] !== '?' ? Number(wlan1Match[1]) : null };
    pingIdx = 4;
  }

  const pingSection = parts[pingIdx].trim();
  const parsePing = (name) => {
    const m = pingSection.match(new RegExp(name + '=([\\d.]+|FAIL)ms'));
    if (!m) return { ms: null, ok: false };
    return m[1] === 'FAIL' ? { ms: null, ok: false } : { ms: parseFloat(m[1]), ok: true };
  };

  const streamSection = parts[pingIdx + 1].trim();
  const parseStream = (name) => {
    const m = streamSection.match(new RegExp(name + '=(\\d+|NO_FILE)s'));
    if (!m) return { age: null, ok: false };
    return m[1] === 'NO_FILE' ? { age: null, ok: false } : { age: Number(m[1]), ok: Number(m[1]) <= 30 };
  };

  const restartsMatch = parts[pingIdx + 2].match(/restarts=(\d+)\/(\d+)(?:\/(\d+))?/);
  const ffmpegMatch = parts[pingIdx + 3] && parts[pingIdx + 3].match(/ffmpeg=(\d+)/);

  let system = { cpu: null, memUsed: null, memTotal: null, load: null, temp: null, diskUsed: null, diskTotal: null };
  const sysSection = parts[pingIdx + 4];
  if (sysSection) {
    const cpuM = sysSection.match(/cpu=([\d.]+|[?])%/);
    const memM = sysSection.match(/mem=(\d+)\/(\d+)MB/);
    const loadM = sysSection.match(/load=([\d.]+|[?])/);
    const tempM = sysSection.match(/temp=([\d.]+|[?])C/);
    const diskM = sysSection.match(/disk=(\d+)\/(\d+)MB/);
    system = {
      cpu: cpuM && cpuM[1] !== '?' ? parseFloat(cpuM[1]) : null,
      memUsed: memM ? Number(memM[1]) : null,
      memTotal: memM ? Number(memM[2]) : null,
      load: loadM && loadM[1] !== '?' ? parseFloat(loadM[1]) : null,
      temp: tempM && tempM[1] !== '?' ? parseFloat(tempM[1]) : null,
      diskUsed: diskM ? Number(diskM[1]) : null,
      diskTotal: diskM ? Number(diskM[2]) : null
    };
  }

  return {
    timestamp,
    eth0,
    wlan0,
    wlan1,
    pings: { cam1: parsePing('cam1'), cam2: parsePing('cam2'), cam3: parsePing('cam3'), wavlink: parsePing('wavlink') },
    streams: { stream1: parseStream('stream1'), stream2: parseStream('stream2'), stream3: parseStream('stream3') },
    restarts: restartsMatch ? { cam1: Number(restartsMatch[1]), cam2: Number(restartsMatch[2]), cam3: restartsMatch[3] ? Number(restartsMatch[3]) : 0 } : { cam1: 0, cam2: 0, cam3: 0 },
    ffmpegCount: ffmpegMatch ? Number(ffmpegMatch[1]) : 0,
    system
  };
}

function generateInfraAlerts(entry) {
  // Each alert has a stable `key` (independent of the changing metric value in the
  // message) so callers can track the same condition across samples — e.g. the
  // push-alert poller requires a critical to persist for several samples before
  // texting, which the value-in-message text alone can't support.
  const alerts = [];
  if (!entry) return [{ level: 'warning', key: 'nodata', message: 'No monitoring data available' }];

  const cam3Enabled = (config.cameras || []).some(c => c.id === 'cam3' && c.enabled);

  if (!entry.pings.cam1.ok) alerts.push({ level: 'critical', key: 'cam1-ping', message: 'Chicken Run camera ping FAILED' });
  if (!entry.pings.cam2.ok) alerts.push({ level: 'critical', key: 'cam2-ping', message: 'Chicken Coop camera ping FAILED' });
  if (cam3Enabled && !entry.pings.cam3.ok) alerts.push({ level: 'critical', key: 'cam3-ping', message: 'Chick Cam ping FAILED' });
  if (!entry.streams.stream1.ok) {
    alerts.push({ level: 'critical', key: 'stream1', message: entry.streams.stream1.age === null ? 'Stream 1 NO_FILE' : `Stream 1 stale (${entry.streams.stream1.age}s)` });
  }
  if (!entry.streams.stream2.ok) {
    alerts.push({ level: 'critical', key: 'stream2', message: entry.streams.stream2.age === null ? 'Stream 2 NO_FILE' : `Stream 2 stale (${entry.streams.stream2.age}s)` });
  }
  if (cam3Enabled && !entry.streams.stream3.ok) {
    alerts.push({ level: 'critical', key: 'stream3', message: entry.streams.stream3.age === null ? 'Stream 3 NO_FILE' : `Stream 3 stale (${entry.streams.stream3.age}s)` });
  }
  if (entry.eth0.state !== 'up') alerts.push({ level: 'critical', key: 'eth0', message: 'eth0 link DOWN' });
  const expectedFfmpeg = cam3Enabled ? 3 : 2;
  if (entry.ffmpegCount < expectedFfmpeg) alerts.push({ level: 'warning', key: 'ffmpeg', message: `Only ${entry.ffmpegCount} of ${expectedFfmpeg} ffmpeg process(es) running` });
  if (entry.wlan1.signal === null) {
    alerts.push({ level: 'warning', key: 'wlan1', message: 'Primary uplink (wlan1) signal lost — failover active' });
    if (entry.wlan0.signal !== null && entry.wlan0.signal < -70) {
      alerts.push({ level: 'warning', key: 'wlan0-weak', message: `Failover WiFi signal weak (${entry.wlan0.signal} dBm)` });
    }
  }
  if (entry.system.cpu !== null && entry.system.cpu > 80) {
    alerts.push({ level: 'critical', key: 'cpu-high', message: `CPU usage high (${entry.system.cpu.toFixed(1)}%)` });
  }
  if (entry.system.temp !== null && entry.system.temp > 75) {
    alerts.push({ level: 'warning', key: 'temp-high', message: `CPU temperature high (${entry.system.temp.toFixed(1)}°C)` });
  }
  if (entry.system.temp !== null && entry.system.temp > 82) {
    alerts.push({ level: 'critical', key: 'temp-critical', message: `CPU temperature critical (${entry.system.temp.toFixed(1)}°C) — throttling likely` });
  }

  return alerts;
}

module.exports = { readLogTail, parseInfraLine, generateInfraAlerts, INFRA_HISTORY_COUNT };
