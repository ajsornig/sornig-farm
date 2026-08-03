const test = require('node:test');
const assert = require('node:assert');
const {
  selectAlertsToSend,
  isSustained,
  ALERT_COOLDOWN_MS,
  MAX_ALERTS_PER_INCIDENT,
  SUSTAIN_SAMPLES,
  ALERT_SUSTAIN_OVERRIDES
} = require('../server/infra-alerts');

const alert = (key) => ({ key, message: `${key} is broken` });
const MINUTE_MS = 60 * 1000;

test('first sighting of a sustained alert sends immediately', () => {
  const { toSend, nextState } = selectAlertsToSend([alert('cam2-ping')], {}, 1000);
  assert.strictEqual(toSend.length, 1);
  assert.deepStrictEqual(nextState['cam2-ping'], { lastSentAt: 1000, sentCount: 1 });
});

test('within cooldown nothing re-sends but state is preserved', () => {
  const state = { 'cam2-ping': { lastSentAt: 1000, sentCount: 1 } };
  const { toSend, nextState } = selectAlertsToSend([alert('cam2-ping')], state, 1000 + MINUTE_MS);
  assert.strictEqual(toSend.length, 0);
  assert.deepStrictEqual(nextState['cam2-ping'], state['cam2-ping']);
});

test('input state object is not mutated', () => {
  const state = { 'cam2-ping': { lastSentAt: 1000, sentCount: 1 } };
  selectAlertsToSend([alert('cam2-ping')], state, 1000 + ALERT_COOLDOWN_MS + 1);
  assert.deepStrictEqual(state, { 'cam2-ping': { lastSentAt: 1000, sentCount: 1 } });
});

test('incident cap: sends stop after MAX_ALERTS_PER_INCIDENT even past cooldown', () => {
  let state = {};
  let now = 0;
  let sentTotal = 0;
  // Simulate an all-night outage: poll every cooldown+1ms for 12 rounds.
  for (let i = 0; i < 12; i++) {
    now += ALERT_COOLDOWN_MS + 1;
    const result = selectAlertsToSend([alert('cam2-ping')], state, now);
    state = result.nextState;
    sentTotal += result.toSend.length;
  }
  assert.strictEqual(sentTotal, MAX_ALERTS_PER_INCIDENT);
});

test('recovery clears state so a recurrence starts a fresh incident', () => {
  const capped = { 'cam2-ping': { lastSentAt: 5000, sentCount: MAX_ALERTS_PER_INCIDENT } };
  // Condition clears: key absent from sustained set -> dropped from state.
  const cleared = selectAlertsToSend([], capped, 6000);
  assert.deepStrictEqual(cleared.nextState, {});
  // It comes back later: alerts again from scratch.
  const recurrence = selectAlertsToSend([alert('cam2-ping')], cleared.nextState, 7000);
  assert.strictEqual(recurrence.toSend.length, 1);
  assert.strictEqual(recurrence.nextState['cam2-ping'].sentCount, 1);
});

test('independent keys are tracked separately', () => {
  const state = { 'cam2-ping': { lastSentAt: 1000, sentCount: MAX_ALERTS_PER_INCIDENT } };
  const { toSend } = selectAlertsToSend([alert('cam2-ping'), alert('disk-full')], state, 1000 + ALERT_COOLDOWN_MS + 1);
  assert.deepStrictEqual(toSend.map(a => a.key), ['disk-full']);
});

// Per-key sustain window: wlan1 requires ALERT_SUSTAIN_OVERRIDES.wlan1 (10)
// consecutive samples, well above the SUSTAIN_SAMPLES (3) default other keys use.
test('a key with the default window is sustained once present in SUSTAIN_SAMPLES samples', () => {
  const perSample = Array.from({ length: SUSTAIN_SAMPLES }, () => new Map([['disk-full', 'Disk nearly full']]));
  assert.strictEqual(isSustained('disk-full', perSample), true);
});

test('wlan1 present in only 3 of the last 10 samples is NOT sustained', () => {
  const required = ALERT_SUSTAIN_OVERRIDES.wlan1;
  const perSample = Array.from({ length: required }, () => new Map());
  // Only the most recent SUSTAIN_SAMPLES (3) carry the wlan1 key.
  for (let i = required - SUSTAIN_SAMPLES; i < required; i++) {
    perSample[i].set('wlan1', 'wlan1 lost');
  }
  assert.strictEqual(isSustained('wlan1', perSample), false);
});

test('wlan1 present in all 10 of the last 10 samples IS sustained', () => {
  const required = ALERT_SUSTAIN_OVERRIDES.wlan1;
  const perSample = Array.from({ length: required }, () => new Map([['wlan1', 'wlan1 lost']]));
  assert.strictEqual(isSustained('wlan1', perSample), true);
});

test('wlan1 cannot be sustained before enough history exists, even if present in every sample seen so far', () => {
  // Only 3 samples of history (e.g. shortly after a restart) — fewer than the
  // wlan1 override requires — must fail safe (not sustained) rather than guess.
  const perSample = Array.from({ length: SUSTAIN_SAMPLES }, () => new Map([['wlan1', 'wlan1 lost']]));
  assert.strictEqual(isSustained('wlan1', perSample), false);
});

// perSample in real operation is always MAX_SUSTAIN_SAMPLES (10) long, so every
// default-window key (disk-full, cam pings, temp, etc.) is judged from within a
// 10-sample array using only its most recent 3 — this is the case that actually
// exercises `.slice(-required)` picking the NEWEST samples, not the oldest.
test('a default-window key is judged on the newest samples of a longer array, not the oldest', () => {
  const stale = Array.from({ length: 10 }, () => new Map());
  for (let i = 0; i < SUSTAIN_SAMPLES; i++) stale[i].set('disk-full', 'Disk nearly full');
  // Condition was only present in the OLDEST 3 of 10 — it recovered 7 samples ago.
  assert.strictEqual(isSustained('disk-full', stale), false);

  const fresh = Array.from({ length: 10 }, () => new Map());
  for (let i = 10 - SUSTAIN_SAMPLES; i < 10; i++) fresh[i].set('disk-full', 'Disk nearly full');
  // Condition is present in the NEWEST 3 of 10 — genuinely sustained right now.
  assert.strictEqual(isSustained('disk-full', fresh), true);
});
