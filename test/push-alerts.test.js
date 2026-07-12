const { describe, it } = require('node:test');
const assert = require('node:assert');

// No VAPID env vars are set in tests, so the module must stay in its
// disabled state and every send must be a safe no-op.
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;
delete process.env.VAPID_SUBJECT;

const {
  initWebPush,
  isPushEnabled,
  getPublicKey,
  shouldPruneSubscription,
  sendPushAlert
} = require('../server/push-alerts');

describe('shouldPruneSubscription', () => {
  it('prunes on 404 and 410 (dead endpoint)', () => {
    assert.strictEqual(shouldPruneSubscription({ statusCode: 404 }), true);
    assert.strictEqual(shouldPruneSubscription({ statusCode: 410 }), true);
  });

  it('keeps the subscription on transient failures', () => {
    assert.strictEqual(shouldPruneSubscription({ statusCode: 500 }), false);
    assert.strictEqual(shouldPruneSubscription({ statusCode: 502 }), false);
    assert.strictEqual(shouldPruneSubscription({ statusCode: 429 }), false);
    assert.strictEqual(shouldPruneSubscription(new Error('ECONNRESET')), false);
  });

  it('handles null/undefined errors', () => {
    assert.strictEqual(shouldPruneSubscription(null), false);
    assert.strictEqual(shouldPruneSubscription(undefined), false);
  });
});

describe('disabled mode (no VAPID env)', () => {
  it('stays disabled after initWebPush without keys', () => {
    initWebPush();
    assert.strictEqual(isPushEnabled(), false);
    assert.strictEqual(getPublicKey(), null);
  });

  it('sendPushAlert is a safe no-op while disabled', async () => {
    const result = await sendPushAlert('Test', 'Body');
    assert.deepStrictEqual(result, { sent: 0, failed: 0, pruned: 0 });
  });
});
