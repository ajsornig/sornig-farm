const test = require('node:test');
const assert = require('node:assert');
const { selectAlertsToSend, ALERT_COOLDOWN_MS, MAX_ALERTS_PER_INCIDENT } = require('../server/infra-alerts');

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
