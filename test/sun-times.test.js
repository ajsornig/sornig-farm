const test = require('node:test');
const assert = require('node:assert');

const SunTimes = require('../public/sun-times.js');

// Reference sunrise/sunset for lat 43.05, lng -83.32 (Lapeer, MI), UTC.
// Source: sunrise-sunset.org API (NOAA-style official zenith 90.833),
// fetched 2026-07-10: /json?lat=43.05&lng=-83.32&date=2026-06-21&formatted=0
// and date=2026-12-21. Cross-checked against timeanddate.com for Lapeer
// (Jun 21 ~05:53 EDT / ~21:17 EDT; Dec 21 ~07:59 EST / ~17:03 EST).
const REF_JUN21_SUNRISE_MS = Date.UTC(2026, 5, 21, 9, 52, 24);  // 2026-06-21T09:52:24Z
const REF_JUN21_SUNSET_MS = Date.UTC(2026, 5, 22, 1, 17, 54);   // 2026-06-22T01:17:54Z (next UTC day)
const REF_DEC21_SUNRISE_MS = Date.UTC(2026, 11, 21, 12, 59, 51); // 2026-12-21T12:59:51Z
const REF_DEC21_SUNSET_MS = Date.UTC(2026, 11, 21, 22, 3, 4);    // 2026-12-21T22:03:04Z

const FIVE_MINUTES_MS = 5 * 60 * 1000;

function assertWithinTolerance(actualMs, expectedMs, label) {
  const deltaMs = Math.abs(actualMs - expectedMs);
  assert.ok(
    deltaMs <= FIVE_MINUTES_MS,
    `${label}: ${new Date(actualMs).toISOString()} is ${(deltaMs / 60000).toFixed(1)} min ` +
    `from reference ${new Date(expectedMs).toISOString()} (tolerance 5 min)`
  );
}

test('summer solstice 2026-06-21 sunrise/sunset within 5 min of reference', () => {
  const win = SunTimes.getSunWindowUtc(2026, 6, 21);
  assertWithinTolerance(win.sunriseMs, REF_JUN21_SUNRISE_MS, 'Jun 21 sunrise');
  assertWithinTolerance(win.sunsetMs, REF_JUN21_SUNSET_MS, 'Jun 21 sunset');
});

test('winter solstice 2026-12-21 sunrise/sunset within 5 min of reference', () => {
  const win = SunTimes.getSunWindowUtc(2026, 12, 21);
  assertWithinTolerance(win.sunriseMs, REF_DEC21_SUNRISE_MS, 'Dec 21 sunrise');
  assertWithinTolerance(win.sunsetMs, REF_DEC21_SUNSET_MS, 'Dec 21 sunset');
});

test('summer sunset lands on the NEXT UTC calendar day (UTC rollover)', () => {
  const win = SunTimes.getSunWindowUtc(2026, 6, 21);
  assert.strictEqual(new Date(win.sunriseMs).getUTCDate(), 21);
  assert.strictEqual(new Date(win.sunsetMs).getUTCDate(), 22);
  assert.ok(win.sunsetMs > win.sunriseMs, 'sunset after sunrise');
});

test('isDaylight: 2026-07-10 20:30 EDT (00:30Z Jul 11) is daylight', () => {
  // Evening daylight after the UTC day has rolled over — belongs to the
  // PREVIOUS UTC day's sun window; pins the two-day check.
  assert.strictEqual(SunTimes.isDaylight(Date.UTC(2026, 6, 11, 0, 30)), true);
});

test('isDaylight: 2026-07-10 22:00 EDT (02:00Z Jul 11) is night', () => {
  assert.strictEqual(SunTimes.isDaylight(Date.UTC(2026, 6, 11, 2, 0)), false);
});

test('isDaylight: winter midday is daylight, winter evening is night', () => {
  // 2026-12-21 12:00 EST = 17:00Z (between 12:59Z sunrise and 22:03Z sunset)
  assert.strictEqual(SunTimes.isDaylight(Date.UTC(2026, 11, 21, 17, 0)), true);
  // 2026-12-21 18:30 EST = 23:30Z (after 22:03Z sunset)
  assert.strictEqual(SunTimes.isDaylight(Date.UTC(2026, 11, 21, 23, 30)), false);
});

test('getSunWindowUtc rejects invalid input explicitly', () => {
  assert.throws(() => SunTimes.getSunWindowUtc(2026, 0, 15), RangeError);
  assert.throws(() => SunTimes.getSunWindowUtc(2026, 13, 15), RangeError);
  assert.throws(() => SunTimes.getSunWindowUtc(NaN, 7, 10), TypeError);
});

test('isDaylight rejects non-finite input explicitly', () => {
  assert.throws(() => SunTimes.isDaylight(NaN), TypeError);
  assert.throws(() => SunTimes.isDaylight(undefined), TypeError);
});
