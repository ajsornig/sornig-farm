const path = require('path');
const { readLogTail, parseInfraLine, generateInfraAlerts } = require('./infra');
const { sendInfraAlert } = require('./mailer');

// Proactive infra alerting. The dashboard already computes critical/warning
// alerts from logs/wifi-monitor.log, but only when an admin has the tab open.
// This poller checks the newest monitor line on an interval and texts/emails the
// owner (via the existing EMAIL_TO SMS/email path) when a CRITICAL condition is
// present — so a set-and-forget Pi surfaces "camera down / disk full / temp
// critical" on its own.
const WIFI_LOG = path.join(__dirname, '../logs/wifi-monitor.log');
const POLL_MS = 60 * 1000;            // wifi-monitor appends one line per minute
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // don't re-send the same alert within 30 min
// Only alert on a critical that PERSISTS across this many consecutive monitor
// samples (~minutes). Filters out transient spikes — e.g. the nightly ffmpeg
// time-lapse encodes briefly peg the CPU >80% for a single minute — while still
// catching a genuinely stuck/pegged condition within a few minutes.
const SUSTAIN_SAMPLES = 3;

// alert key -> last-sent timestamp. Keyed by the stable `key` (not the message,
// which carries a changing metric value). In-memory only: a restart clears it, so
// an ongoing outage may re-alert once after a restart — acceptable for an
// unattended box.
const lastSentAt = new Map();

function poll() {
  try {
    let raw;
    try {
      raw = readLogTail(WIFI_LOG, 64 * 1024);
    } catch (err) {
      return; // log not present yet
    }
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length < SUSTAIN_SAMPLES) return; // not enough history yet

    const recent = lines.slice(-SUSTAIN_SAMPLES).map(parseInfraLine);
    if (recent.some(e => !e)) return; // a sample didn't parse — don't guess

    // For each sample: the critical alerts keyed by stable id -> message.
    const perSample = recent.map(e =>
      new Map(generateInfraAlerts(e)
        .filter(a => a.level === 'critical')
        .map(a => [a.key, a.message]))
    );
    const latest = perSample[perSample.length - 1];
    // Sustained = the critical is present in EVERY one of the last N samples.
    const sustainedKeys = [...latest.keys()].filter(k => perSample.every(m => m.has(k)));

    const now = Date.now();
    const toSend = [];
    for (const key of sustainedKeys) {
      const last = lastSentAt.get(key) || 0;
      if (now - last > ALERT_COOLDOWN_MS) {
        toSend.push(latest.get(key)); // current message text (with live value)
        lastSentAt.set(key, now);
      }
    }

    if (toSend.length > 0) {
      // One combined message per poll — never a burst of separate texts.
      sendInfraAlert('Sornig Farm infra alert (sustained ' + SUSTAIN_SAMPLES + '+ min):\n' + toSend.join('\n'));
    }
  } catch (err) {
    console.error('Infra alert poll failed:', err.message);
  }
}

function startInfraAlertPoller() {
  // Don't poll immediately on boot — let the first interval tick establish state,
  // avoiding a burst right after a restart.
  const timer = setInterval(poll, POLL_MS);
  if (timer.unref) timer.unref();
}

module.exports = { startInfraAlertPoller };
