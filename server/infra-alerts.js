const path = require('path');
const { readLogTail, parseInfraLine, generateInfraAlerts } = require('./infra');
const { sendInfraAlert } = require('./mailer');
const { sendPushAlert } = require('./push-alerts');
const { getCamStates } = require('./camera-state');
const { maybeRunDiskPrune } = require('./disk-prune');

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
// Per incident (a key continuously sustained): first alert + 2 reminders, then
// silence until the condition clears and recurs. Stops the every-30-min SMS
// stream during a known all-night outage (2026-07-10 coop-cam incident).
const MAX_ALERTS_PER_INCIDENT = 3;

// alert key -> { lastSentAt, sentCount }. Keyed by the stable `key` (not the
// message, which carries a changing metric value). Keys drop out of the state
// the moment they stop being sustained, so recovery resets the incident.
// In-memory only: a restart clears it, so an ongoing outage may re-alert once
// after a restart — acceptable for an unattended box.
let alertState = {};

// Pure send decision: which sustained criticals get (re)sent now, and the next
// state. A key is sent when its cooldown elapsed AND it is under the incident
// cap; keys absent from `sustainedAlerts` are dropped from the state entirely,
// so a recovered condition starts a fresh incident if it recurs.
function selectAlertsToSend(sustainedAlerts, state, now) {
  const toSend = [];
  const nextState = {};
  for (const alert of sustainedAlerts) {
    const prev = state[alert.key] || { lastSentAt: 0, sentCount: 0 };
    // Never-sent keys fire immediately; only re-sends wait out the cooldown.
    const cooldownElapsed = prev.sentCount === 0 || now - prev.lastSentAt > ALERT_COOLDOWN_MS;
    const underCap = prev.sentCount < MAX_ALERTS_PER_INCIDENT;
    if (cooldownElapsed && underCap) {
      toSend.push(alert);
      nextState[alert.key] = { lastSentAt: now, sentCount: prev.sentCount + 1 };
    } else {
      nextState[alert.key] = prev;
    }
  }
  return { toSend, nextState };
}

// The last SUSTAIN_SAMPLES parsed monitor samples, or null if there aren't
// enough clean ones yet (log missing, short, or a line failed to parse).
function readRecentSamples() {
  let raw;
  try {
    raw = readLogTail(WIFI_LOG, 64 * 1024);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Infra alert poll: cannot read monitor log:', err.message);
    return null;
  }
  const lines = raw.split('\n').filter(Boolean);
  if (lines.length < SUSTAIN_SAMPLES) return null;
  const recent = lines.slice(-SUSTAIN_SAMPLES).map(parseInfraLine);
  if (recent.some(e => !e)) return null; // a sample didn't parse — don't guess
  return recent;
}

function checkDiskPrune(latestEntry, now) {
  try {
    const summary = maybeRunDiskPrune(latestEntry.system, now);
    if (summary && (summary.deleted.length > 0 || summary.failed.length > 0)) {
      const pruneMessage =
        `Sornig Farm disk auto-prune ran: freed ~${summary.freedMb}MB ` +
        `(${summary.deleted.length} deleted, ${summary.failed.length} failed) — ` +
        `free space was ${summary.freeMbBefore}MB.`;
      sendInfraAlert(pruneMessage);
      // Push is additive alongside email/SMS; sendPushAlert never rejects.
      sendPushAlert('Sornig Farm', pruneMessage);
    }
  } catch (err) {
    console.error('Disk auto-prune failed:', err.message);
  }
}

function poll() {
  try {
    const recent = readRecentSamples();
    if (!recent) return;

    // Fresh camera states each tick, so an admin-panel toggle takes effect on
    // the very next poll. If they can't be loaded, alert on everything rather
    // than stay silent during a real outage.
    let camStates = null;
    try {
      camStates = getCamStates();
    } catch (err) {
      console.error('Infra alert poll: camera states unavailable:', err.message);
    }

    // Per sample: critical, non-muted alerts keyed by stable id -> message.
    // Muted alerts (cam disabled in admin panel) stay on the dashboard but are
    // never pushed — the outage is intentional.
    const perSample = recent.map(e =>
      new Map(generateInfraAlerts(e, camStates)
        .filter(a => a.level === 'critical' && !a.muted)
        .map(a => [a.key, a.message]))
    );
    const latest = perSample[perSample.length - 1];
    // Sustained = the critical is present in EVERY one of the last N samples.
    const sustained = [...latest.keys()]
      .filter(key => perSample.every(m => m.has(key)))
      .map(key => ({ key, message: latest.get(key) })); // current message (live value)

    const now = Date.now();
    const { toSend, nextState } = selectAlertsToSend(sustained, alertState, now);
    alertState = nextState;

    if (toSend.length > 0) {
      // One combined message per poll — never a burst of separate texts.
      const alertBody = toSend.map(a => a.message).join('\n');
      sendInfraAlert('Sornig Farm infra alert (sustained ' + SUSTAIN_SAMPLES + '+ min):\n' + alertBody);
      // Push is additive alongside email/SMS; sendPushAlert never rejects.
      sendPushAlert('Sornig Farm ALERT', alertBody);
    }

    checkDiskPrune(recent[recent.length - 1], now);
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

module.exports = {
  startInfraAlertPoller,
  selectAlertsToSend,
  ALERT_COOLDOWN_MS,
  MAX_ALERTS_PER_INCIDENT,
  SUSTAIN_SAMPLES
};
