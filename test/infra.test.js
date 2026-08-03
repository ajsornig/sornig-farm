const test = require('node:test');
const assert = require('node:assert');
const { parseInfraLine, generateInfraAlerts, DISK_CRITICAL_FREE_MB } = require('../server/infra');

// Real wifi-monitor line shape: cam2 ping failed (cam2=ms) and stream2 stale.
const SAMPLE_LINE = '2026-07-10 02:30:28 | eth0=up@1000Mbps | wlan0=-50dBm | wlan1=-50dBm | ' +
  'cam1=17.8ms cam2=ms cam3=4.28ms wavlink=0.516ms | stream1=4s stream2=204s stream3=2s | ' +
  'restarts=0/0/0 cfdrops=0 | ffmpeg=6 | cpu=10.0% mem=1000/8000MB load=0.5 temp=50.0C disk=9400/230000MB';

const HEALTHY_LINE = '2026-07-10 02:30:28 | eth0=up@1000Mbps | wlan0=-50dBm | wlan1=-50dBm | ' +
  'cam1=17.8ms cam2=2.1ms cam3=4.28ms wavlink=0.516ms | stream1=4s stream2=5s stream3=2s | ' +
  'restarts=0/0/0 cfdrops=0 | ffmpeg=6 | cpu=10.0% mem=1000/8000MB load=0.5 temp=50.0C disk=9400/230000MB';

const camStates = (overrides = {}) => [
  { id: 'cam1', name: 'Chicken Run', enabled: true, hidden: false },
  { id: 'cam2', name: 'Chicken Coop', enabled: true, hidden: false },
  { id: 'cam3', name: 'Chick Cam', enabled: true, hidden: false }
].map(c => (overrides[c.id] ? { ...c, ...overrides[c.id] } : c));

test('parseInfraLine extracts pings, streams, and disk metrics', () => {
  const entry = parseInfraLine(SAMPLE_LINE);
  assert.ok(entry);
  assert.strictEqual(entry.pings.cam1.ok, true);
  assert.strictEqual(entry.pings.cam2.ok, false);
  assert.strictEqual(entry.streams.stream2.ok, false);
  assert.strictEqual(entry.system.diskUsed, 9400);
  assert.strictEqual(entry.system.diskTotal, 230000);
});

test('down cam emits critical ping and stream alerts when visible', () => {
  const alerts = generateInfraAlerts(parseInfraLine(SAMPLE_LINE), camStates());
  const keys = alerts.map(a => a.key);
  assert.ok(keys.includes('cam2-ping'));
  assert.ok(keys.includes('stream2'));
  assert.ok(alerts.every(a => !a.muted));
});

test('hidden cam alerts are emitted but muted with a suffix', () => {
  const alerts = generateInfraAlerts(parseInfraLine(SAMPLE_LINE), camStates({ cam2: { hidden: true } }));
  const camPing = alerts.find(a => a.key === 'cam2-ping');
  const stream = alerts.find(a => a.key === 'stream2');
  assert.ok(camPing && camPing.muted === true);
  assert.ok(stream && stream.muted === true);
  assert.ok(camPing.message.includes('(muted — camera disabled in admin panel)'));
  // Unrelated alerts stay unmuted.
  assert.ok(alerts.filter(a => a.key !== 'cam2-ping' && a.key !== 'stream2').every(a => !a.muted));
});

test('config-disabled cam emits no ping/stream alerts at all', () => {
  const alerts = generateInfraAlerts(parseInfraLine(SAMPLE_LINE), camStates({ cam2: { enabled: false } }));
  const keys = alerts.map(a => a.key);
  assert.ok(!keys.includes('cam2-ping'));
  assert.ok(!keys.includes('stream2'));
});

test('cam3 disabled lowers the expected ffmpeg count (legacy behavior generalized)', () => {
  const line = HEALTHY_LINE.replace('ffmpeg=6', 'ffmpeg=2');
  const alerts = generateInfraAlerts(parseInfraLine(line), camStates({ cam3: { enabled: false } }));
  assert.ok(!alerts.some(a => a.key === 'ffmpeg'));
  const alertsAllOn = generateInfraAlerts(parseInfraLine(line), camStates());
  assert.ok(alertsAllOn.some(a => a.key === 'ffmpeg'));
});

test('disk-full critical fires below the free-MB floor', () => {
  const line = HEALTHY_LINE.replace('disk=9400/230000MB', `disk=229000/230000MB`);
  const alerts = generateInfraAlerts(parseInfraLine(line), camStates());
  const disk = alerts.find(a => a.key === 'disk-full');
  assert.ok(disk);
  assert.strictEqual(disk.level, 'critical');
});

test('disk-full critical fires above the used-percent ceiling', () => {
  // 95% used but >2048MB free (large disk): percent rule must still trip.
  const line = HEALTHY_LINE.replace('disk=9400/230000MB', 'disk=218500/230000MB');
  const entry = parseInfraLine(line);
  assert.ok(entry.system.diskTotal - entry.system.diskUsed > DISK_CRITICAL_FREE_MB);
  assert.ok(generateInfraAlerts(entry, camStates()).some(a => a.key === 'disk-full'));
});

test('disk alert is skipped when disk metrics are absent', () => {
  const line = HEALTHY_LINE.replace(' disk=9400/230000MB', '');
  const entry = parseInfraLine(line);
  assert.strictEqual(entry.system.diskUsed, null);
  assert.ok(!generateInfraAlerts(entry, camStates()).some(a => a.key === 'disk-full'));
});

test('healthy line with all cams visible produces no alerts', () => {
  assert.deepStrictEqual(generateInfraAlerts(parseInfraLine(HEALTHY_LINE), camStates()), []);
});

test('lost wlan1 signal emits a critical alert (push/SMS poller only sends critical)', () => {
  const line = HEALTHY_LINE.replace('wlan1=-50dBm', 'wlan1=?dBm');
  const alerts = generateInfraAlerts(parseInfraLine(line), camStates());
  const wlan1 = alerts.find(a => a.key === 'wlan1');
  assert.ok(wlan1);
  assert.strictEqual(wlan1.level, 'critical');
});

test('healthy wlan1 signal produces no wlan1 alert', () => {
  const alerts = generateInfraAlerts(parseInfraLine(HEALTHY_LINE), camStates());
  assert.ok(!alerts.some(a => a.key === 'wlan1'));
});

test('weak wlan0 primary alert stays warning even when wlan1 (backup) also escalates to critical', () => {
  const line = HEALTHY_LINE.replace('wlan1=-50dBm', 'wlan1=?dBm').replace('wlan0=-50dBm', 'wlan0=-75dBm');
  const alerts = generateInfraAlerts(parseInfraLine(line), camStates());
  const wlan1 = alerts.find(a => a.key === 'wlan1');
  const wlan0Weak = alerts.find(a => a.key === 'wlan0-weak');
  assert.strictEqual(wlan1.level, 'critical');
  assert.ok(wlan0Weak);
  assert.strictEqual(wlan0Weak.level, 'warning');
});

// Regression coverage: wlan0-weak used to be nested inside the wlan1-lost branch,
// so it only ever fired when wlan1 ALSO happened to be unreadable at that exact
// moment. Now that wlan0 is the primary uplink carrying all traffic, its signal
// must be checked unconditionally.
test('wlan0-weak warning fires on its own, with wlan1 signal perfectly healthy', () => {
  const line = HEALTHY_LINE.replace('wlan0=-50dBm', 'wlan0=-75dBm');
  const alerts = generateInfraAlerts(parseInfraLine(line), camStates());
  const wlan0Weak = alerts.find(a => a.key === 'wlan0-weak');
  assert.ok(wlan0Weak);
  assert.strictEqual(wlan0Weak.level, 'warning');
  assert.ok(!alerts.some(a => a.key === 'wlan1'));
});

// Regression guard for the 2026-08-02 wording fix: wlan1 (BrosTrend) is now the
// BACKUP uplink, not primary, and losing its signal doesn't trigger a failover
// (wlan0/primary was already carrying all traffic) — the message must not imply
// otherwise.
test('wlan1 critical message no longer claims it is the primary uplink or that failover occurred', () => {
  const line = HEALTHY_LINE.replace('wlan1=-50dBm', 'wlan1=?dBm');
  const alerts = generateInfraAlerts(parseInfraLine(line), camStates());
  const wlan1 = alerts.find(a => a.key === 'wlan1');
  assert.ok(wlan1);
  assert.ok(!/primary/i.test(wlan1.message));
  assert.ok(!/failover/i.test(wlan1.message));
});

test('parseInfraLine extracts cfDrops from the cfdrops field', () => {
  const line = SAMPLE_LINE.replace('cfdrops=0', 'cfdrops=3');
  const entry = parseInfraLine(line);
  assert.strictEqual(entry.cfDrops, 3);
});

test('cfDrops defaults to 0 when the field is missing', () => {
  const line = SAMPLE_LINE.replace(' cfdrops=0', '');
  const entry = parseInfraLine(line);
  assert.strictEqual(entry.cfDrops, 0);
});
