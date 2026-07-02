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

// message -> last-sent timestamp. In-memory only: a restart clears it, so an
// ongoing outage may re-alert once after a restart — acceptable (and arguably
// desirable) for an unattended box.
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
    if (lines.length === 0) return;

    const entry = parseInfraLine(lines[lines.length - 1]);
    if (!entry) return;

    const now = Date.now();
    const toSend = [];
    for (const alert of generateInfraAlerts(entry)) {
      if (alert.level !== 'critical') continue;
      const last = lastSentAt.get(alert.message) || 0;
      if (now - last > ALERT_COOLDOWN_MS) {
        toSend.push(alert.message);
        lastSentAt.set(alert.message, now);
      }
    }

    if (toSend.length > 0) {
      // One combined message per poll — never a burst of separate texts.
      sendInfraAlert('Sornig Farm infra alert:\n' + toSend.join('\n'));
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
