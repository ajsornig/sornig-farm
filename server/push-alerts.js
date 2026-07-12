// Web-push fan-out for infra alerts. Mirrors mailer.js's graceful-degrade
// pattern: without VAPID keys in .env (or with web-push not installed, e.g. a
// git pull before npm install), every send is a logged no-op — a push problem
// must never take down the server or the infra poller.
const db = require('./db');

// Guarded require: web-push is the repo's one push dependency; if the Pi gets
// new code before `npm install`, boot must survive it.
let webpush = null;
try {
  webpush = require('web-push');
} catch (err) {
  console.warn('web-push module not installed — push notifications disabled');
}

let pushEnabled = false;

function initWebPush() {
  if (!webpush) return;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) {
    console.log('Push notifications disabled (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT not set)');
    return;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  pushEnabled = true;
  console.log('Web push enabled');
}

function isPushEnabled() {
  return pushEnabled;
}

function getPublicKey() {
  return pushEnabled ? process.env.VAPID_PUBLIC_KEY : null;
}

// 404/410 from the push service mean the subscription is dead (user revoked
// permission, reinstalled, or the endpoint expired) — prune it. Anything else
// (5xx, network) is transient: keep the subscription and retry next alert.
function shouldPruneSubscription(err) {
  return !!err && (err.statusCode === 404 || err.statusCode === 410);
}

// Sends { title, body } to every stored subscription. Resolves to
// { sent, failed, pruned }; never rejects.
async function sendPushAlert(title, body) {
  if (!pushEnabled) return { sent: 0, failed: 0, pruned: 0 };
  const subscriptions = db.getPushSubscriptions();
  if (!subscriptions.length) return { sent: 0, failed: 0, pruned: 0 };

  const payload = JSON.stringify({ title, body });
  const results = await Promise.allSettled(
    subscriptions.map(sub =>
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        payload
      )
    )
  );

  let sent = 0;
  let failed = 0;
  let pruned = 0;
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      sent++;
      return;
    }
    if (shouldPruneSubscription(result.reason)) {
      db.removePushSubscription(subscriptions[i].endpoint);
      pruned++;
    } else {
      failed++;
      console.error('Push send failed:', result.reason && result.reason.message);
    }
  });
  if (pruned) console.log(`Pruned ${pruned} dead push subscription(s)`);
  return { sent, failed, pruned };
}

module.exports = {
  initWebPush,
  isPushEnabled,
  getPublicKey,
  shouldPruneSubscription,
  sendPushAlert
};
