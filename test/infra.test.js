const test = require('node:test');
const assert = require('node:assert');
const { parseInfraLine, generateInfraAlerts, DISK_CRITICAL_FREE_MB } = require('../server/infra');

// Real wifi-monitor line shape: cam2 ping failed (cam2=ms) and stream2 stale.
const SAMPLE_LINE = '2026-07-10 02:30:28 | eth0=up@1000Mbps | wlan0=-50dBm | wlan1=-50dBm | ' +
  'cam1=17.8ms cam2=ms cam3=4.28ms wavlink=0.516ms | stream1=4s stream2=204s stream3=2s | ' +
  'restarts=0/0/0 | ffmpeg=6 | cpu=10.0% mem=1000/8000MB load=0.5 temp=50.0C disk=9400/230000MB';

const HEALTHY_LINE = '2026-07-10 02:30:28 | eth0=up@1000Mbps | wlan0=-50dBm | wlan1=-50dBm | ' +
  'cam1=17.8ms cam2=2.1ms cam3=4.28ms wavlink=0.516ms | stream1=4s stream2=5s stream3=2s | ' +
  'restarts=0/0/0 | ffmpeg=6 | cpu=10.0% mem=1000/8000MB load=0.5 temp=50.0C disk=9400/230000MB';

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
