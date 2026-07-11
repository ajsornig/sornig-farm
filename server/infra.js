const fs = require('fs');

const INFRA_HISTORY_COUNT = 60;

// Disk is CRITICAL when free space drops below this many MB…
const DISK_CRITICAL_FREE_MB = 2048;
// …or when used space exceeds this percentage of the card.
const DISK_CRITICAL_USED_PCT = 90;

// Appended to alerts for cams the admin disabled via the panel — the dashboard
// still shows them, but the push poller drops anything flagged `muted`.
const MUTED_SUFFIX = ' (muted — camera disabled in admin panel)';

// Fallback when a caller has no camera states available (e.g. legacy tests):
// assume every cam is on so no outage is ever silently skipped.
const DEFAULT_CAM_STATES = [
  { id: 'cam1', name: 'Chicken Run', enabled: true, hidden: false },
  { id: 'cam2', name: 'Chicken Coop', enabled: true, hidden: false },
  { id: 'cam3', name: 'Chick Cam', enabled: true, hidden: false }
];

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

// Ping/stream alerts for one camera. A cam the owner disabled in config
// (`enabled: false`) produces nothing — it is expected to be offline. A cam
// hidden via the admin panel still alerts (dashboard should show the outage)
// but flagged `muted` so the push poller skips it.
function collectCamAlerts(entry, camState) {
  const camIdMatch = camState.id.match(/^cam(\d+)$/);
  if (!camIdMatch || camState.enabled === false) return [];
  const camNumber = camIdMatch[1];
  const label = camState.name || camState.id;

  const found = [];
  const ping = entry.pings[camState.id];
  if (ping && !ping.ok) {
    found.push({ level: 'critical', key: `${camState.id}-ping`, message: `${label} ping FAILED` });
  }
  const stream = entry.streams[`stream${camNumber}`];
  if (stream && !stream.ok) {
    const message = stream.age === null
      ? `Stream ${camNumber} NO_FILE`
      : `Stream ${camNumber} stale (${stream.age}s)`;
    found.push({ level: 'critical', key: `stream${camNumber}`, message });
  }
  if (!camState.hidden) return found;
  return found.map(a => ({ ...a, muted: true, message: a.message + MUTED_SUFFIX }));
}

// Critical when the SD card is nearly full — either absolute free MB or used
// percentage. Null-safe: skips entirely when the monitor line had no disk field.
function collectDiskAlert(system) {
  if (system.diskUsed === null || system.diskTotal === null || !(system.diskTotal > 0)) return [];
  const freeMb = system.diskTotal - system.diskUsed;
  const usedPct = (system.diskUsed / system.diskTotal) * 100;
  if (freeMb >= DISK_CRITICAL_FREE_MB && usedPct <= DISK_CRITICAL_USED_PCT) return [];
  return [{
    level: 'critical',
    key: 'disk-full',
    message: `Disk nearly full (${freeMb}MB free, ${usedPct.toFixed(1)}% used)`
  }];
}

function generateInfraAlerts(entry, camStates) {
  // Each alert has a stable `key` (independent of the changing metric value in the
  // message) so callers can track the same condition across samples — e.g. the
  // push-alert poller requires a critical to persist for several samples before
  // texting, which the value-in-message text alone can't support.
  if (!entry) return [{ level: 'warning', key: 'nodata', message: 'No monitoring data available' }];

  const states = Array.isArray(camStates) && camStates.length > 0 ? camStates : DEFAULT_CAM_STATES;
  const alerts = states.flatMap(camState => collectCamAlerts(entry, camState));

  if (entry.eth0.state !== 'up') alerts.push({ level: 'critical', key: 'eth0', message: 'eth0 link DOWN' });
  const expectedFfmpeg = states.filter(c => c.enabled !== false).length;
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
  alerts.push(...collectDiskAlert(entry.system));

  return alerts;
}

module.exports = {
  readLogTail,
  parseInfraLine,
  generateInfraAlerts,
  INFRA_HISTORY_COUNT,
  DISK_CRITICAL_FREE_MB,
  DISK_CRITICAL_USED_PCT
};
