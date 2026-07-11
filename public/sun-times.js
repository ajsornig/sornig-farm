// Sunrise/sunset calculator for the farm (Lapeer, MI), ported from
// scripts/sun-times.py (NOAA solar calculation, low-accuracy Fourier form:
// https://gml.noaa.gov/grad/solcalc/solareqns.PDF). Everything is UTC epoch
// milliseconds — no timezone or DST math anywhere.
//
// Loads as a plain browser script (defines window.SunTimes) and as a CommonJS
// module for node:test (module.exports tail at the bottom).
(function (root) {
  'use strict';

  var FARM_LAT = 43.05;
  var FARM_LNG = -83.32;

  var MS_PER_MINUTE = 60 * 1000;
  var MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
  var MONTHS_PER_YEAR = 12;
  var DAYS_PER_YEAR = 365; // NOAA low-accuracy form ignores leap years
  var SOLAR_NOON_UTC_MINUTES = 720; // 12:00 UTC, reference point of the NOAA formula
  var MINUTES_PER_LONGITUDE_DEGREE = 4; // Earth rotates 1 degree every 4 minutes
  // Sun's center 0.833 degrees below horizon at rise/set: 0.567 atmospheric
  // refraction + 0.266 solar semi-diameter (NOAA "official" sunrise/sunset).
  var OFFICIAL_ZENITH_DEGREES = 90.833;
  // 1440 minutes/day divided by 2*pi radians: converts the equation-of-time
  // Fourier series (radians of hour angle) to minutes.
  var EQ_OF_TIME_MINUTES_PER_RADIAN = 229.18;

  function toRadians(degrees) {
    return (degrees * Math.PI) / 180;
  }

  function toDegrees(radians) {
    return (radians * 180) / Math.PI;
  }

  /**
   * Sunrise/sunset for one UTC calendar day at the farm.
   *
   * Month is 1-BASED (1 = January ... 12 = December), unlike JS Date's 0-based
   * months — e.g. getSunWindowUtc(2026, 7, 10) is July 10, 2026 (UTC).
   *
   * Returned values are absolute epoch milliseconds. sunsetMs may land on the
   * NEXT UTC calendar day: in Michigan summer, sunset (~21:10 EDT) is ~01:10
   * UTC the following day. That is correct — callers compare absolute ms.
   *
   * @param {number} utcYear  full year, e.g. 2026
   * @param {number} utcMonth 1-based month (1-12)
   * @param {number} utcDay   day of month (1-31)
   * @returns {{ sunriseMs: number, sunsetMs: number }}
   */
  function getSunWindowUtc(utcYear, utcMonth, utcDay) {
    if (!Number.isFinite(utcYear) || !Number.isFinite(utcMonth) || !Number.isFinite(utcDay)) {
      throw new TypeError('getSunWindowUtc: year/month/day must be finite numbers');
    }
    if (utcMonth < 1 || utcMonth > MONTHS_PER_YEAR) {
      throw new RangeError('getSunWindowUtc: month must be 1-12 (1-based), got ' + utcMonth);
    }

    var dayStartMs = Date.UTC(utcYear, utcMonth - 1, utcDay);
    var yearStartMs = Date.UTC(utcYear, 0, 1);
    var dayOfYear = Math.round((dayStartMs - yearStartMs) / MS_PER_DAY) + 1;

    // Fractional year (radians)
    var gamma = ((2 * Math.PI) / DAYS_PER_YEAR) * (dayOfYear - 1);

    // Equation of time (minutes) — NOAA Fourier coefficients
    var eqTimeMinutes = EQ_OF_TIME_MINUTES_PER_RADIAN * (
      0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma)
    );

    // Solar declination (radians) — NOAA Fourier coefficients
    var declinationRad =
      0.006918 -
      0.399912 * Math.cos(gamma) +
      0.070257 * Math.sin(gamma) -
      0.006758 * Math.cos(2 * gamma) +
      0.000907 * Math.sin(2 * gamma) -
      0.002697 * Math.cos(3 * gamma) +
      0.00148 * Math.sin(3 * gamma);

    var latRad = toRadians(FARM_LAT);

    // Hour angle at official sunrise/sunset (degrees), clamped for polar edge cases
    var cosHourAngle =
      Math.cos(toRadians(OFFICIAL_ZENITH_DEGREES)) / (Math.cos(latRad) * Math.cos(declinationRad)) -
      Math.tan(latRad) * Math.tan(declinationRad);
    cosHourAngle = Math.max(-1, Math.min(1, cosHourAngle));
    var hourAngleDeg = toDegrees(Math.acos(cosHourAngle));

    // Minutes from midnight UTC of the requested day (sunset may exceed 1440)
    var sunriseUtcMinutes =
      SOLAR_NOON_UTC_MINUTES - MINUTES_PER_LONGITUDE_DEGREE * (FARM_LNG + hourAngleDeg) - eqTimeMinutes;
    var sunsetUtcMinutes =
      SOLAR_NOON_UTC_MINUTES - MINUTES_PER_LONGITUDE_DEGREE * (FARM_LNG - hourAngleDeg) - eqTimeMinutes;

    return {
      sunriseMs: dayStartMs + sunriseUtcMinutes * MS_PER_MINUTE,
      sunsetMs: dayStartMs + sunsetUtcMinutes * MS_PER_MINUTE
    };
  }

  /**
   * True if nowMs (epoch ms) falls inside the daylight window of EITHER the
   * current UTC calendar day or the previous one. The two-day check is
   * load-bearing: a Michigan summer evening (e.g. 20:30 EDT = 00:30 UTC) has
   * already rolled to the next UTC day, whose own window hasn't started —
   * daylight there belongs to the PREVIOUS UTC day's window.
   *
   * @param {number} nowMs epoch milliseconds
   * @returns {boolean}
   */
  function isDaylight(nowMs) {
    if (!Number.isFinite(nowMs)) {
      throw new TypeError('isDaylight: nowMs must be a finite epoch-ms number');
    }

    function isInWindow(ms, dateForDay) {
      var win = getSunWindowUtc(
        dateForDay.getUTCFullYear(),
        dateForDay.getUTCMonth() + 1,
        dateForDay.getUTCDate()
      );
      return ms >= win.sunriseMs && ms < win.sunsetMs;
    }

    return (
      isInWindow(nowMs, new Date(nowMs)) ||
      isInWindow(nowMs, new Date(nowMs - MS_PER_DAY))
    );
  }

  var SunTimes = {
    FARM_LAT: FARM_LAT,
    FARM_LNG: FARM_LNG,
    getSunWindowUtc: getSunWindowUtc,
    isDaylight: isDaylight
  };

  root.SunTimes = SunTimes;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SunTimes;
  }
})(typeof window !== 'undefined' ? window : globalThis);
