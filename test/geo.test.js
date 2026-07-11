const { describe, it } = require('node:test');
const assert = require('node:assert');

const { isPrivateIP, geolocateIP } = require('../server/geo');

describe('isPrivateIP', () => {
  it('flags RFC1918 10.0.0.0/8', () => {
    assert.strictEqual(isPrivateIP('10.0.0.1'), true);
    assert.strictEqual(isPrivateIP('10.255.255.255'), true);
  });

  it('flags RFC1918 192.168.0.0/16', () => {
    assert.strictEqual(isPrivateIP('192.168.1.1'), true);
    assert.strictEqual(isPrivateIP('192.168.4.74'), true);
  });

  it('flags RFC1918 172.16.0.0/12 — both edges of the range', () => {
    assert.strictEqual(isPrivateIP('172.16.0.1'), true);
    assert.strictEqual(isPrivateIP('172.20.5.5'), true);
    assert.strictEqual(isPrivateIP('172.31.255.255'), true);
  });

  it('does NOT flag addresses just outside the /12 boundary', () => {
    assert.strictEqual(isPrivateIP('172.15.255.255'), false);
    assert.strictEqual(isPrivateIP('172.32.0.1'), false);
    // Third octet must not bleed into the second-octet match (172.160.x is public).
    assert.strictEqual(isPrivateIP('172.160.0.1'), false);
  });

  it('flags link-local 169.254.0.0/16', () => {
    assert.strictEqual(isPrivateIP('169.254.1.1'), true);
  });

  it('flags loopback (IPv4 and IPv6)', () => {
    assert.strictEqual(isPrivateIP('127.0.0.1'), true);
    assert.strictEqual(isPrivateIP('127.1.2.3'), true);
    assert.strictEqual(isPrivateIP('::1'), true);
  });

  it('does not flag public addresses', () => {
    assert.strictEqual(isPrivateIP('8.8.8.8'), false);
    assert.strictEqual(isPrivateIP('1.1.1.1'), false);
    assert.strictEqual(isPrivateIP('203.0.113.9'), false);
    assert.strictEqual(isPrivateIP('11.0.0.1'), false);      // just past 10/8
    assert.strictEqual(isPrivateIP('192.169.0.1'), false);   // just past 192.168/16
  });

  it('does NOT itself strip the ::ffff: IPv4-mapped prefix (callers strip first)', () => {
    // Documented contract: geolocateIP strips ::ffff: before calling this, so
    // isPrivateIP only understands plain forms. A mapped private address passed
    // directly is not recognized — the mapped-form handling is tested through
    // geolocateIP below.
    assert.strictEqual(isPrivateIP('::ffff:192.168.1.1'), false);
    assert.strictEqual(isPrivateIP('::ffff:10.0.0.5'), false);
  });
});

describe('geolocateIP private/mapped short-circuit (no network)', () => {
  // These all return null BEFORE any fetch: private and loopback addresses are
  // rejected up front, which is also what keeps these tests offline-safe.
  it('returns null for ::ffff:-mapped private addresses (strip step works)', async () => {
    assert.strictEqual(await geolocateIP('::ffff:192.168.1.1'), null);
    assert.strictEqual(await geolocateIP('::ffff:10.0.0.5'), null);
    assert.strictEqual(await geolocateIP('::ffff:127.0.0.1'), null);
  });

  it('strips the mapped prefix case-insensitively', async () => {
    assert.strictEqual(await geolocateIP('::FFFF:172.16.0.1'), null);
  });

  it('returns null for plain private and loopback addresses', async () => {
    assert.strictEqual(await geolocateIP('192.168.4.50'), null);
    assert.strictEqual(await geolocateIP('::1'), null);
  });

  it('returns null for empty/missing input', async () => {
    assert.strictEqual(await geolocateIP(''), null);
    assert.strictEqual(await geolocateIP(null), null);
    assert.strictEqual(await geolocateIP(undefined), null);
  });
});
