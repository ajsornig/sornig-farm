const { describe, it } = require('node:test');
const assert = require('node:assert');

const { getClientIp, normalizeForGate } = require('../server/security');

// Minimal fake of the Express request surface getClientIp actually reads:
// req.socket.remoteAddress, req.headers, req.ip.
function makeReq(peer, headers = {}, ip) {
  return { socket: { remoteAddress: peer }, headers, ip };
}

describe('getClientIp', () => {
  it('honors cf-connecting-ip when the peer is IPv6 loopback (cloudflared hop)', () => {
    const req = makeReq('::1', { 'cf-connecting-ip': '203.0.113.9' });
    assert.strictEqual(getClientIp(req), '203.0.113.9');
  });

  it('honors cf-connecting-ip when the peer is IPv4 loopback', () => {
    const req = makeReq('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9' });
    assert.strictEqual(getClientIp(req), '203.0.113.9');
  });

  it('treats an IPv4-mapped loopback peer (::ffff:127.0.0.1) as trusted', () => {
    const req = makeReq('::ffff:127.0.0.1', { 'cf-connecting-ip': '203.0.113.9' });
    assert.strictEqual(getClientIp(req), '203.0.113.9');
  });

  it('falls back to the first x-forwarded-for hop (trimmed) when cf header is absent', () => {
    const req = makeReq('127.0.0.1', { 'x-forwarded-for': ' 198.51.100.7 , 10.0.0.1' });
    assert.strictEqual(getClientIp(req), '198.51.100.7');
  });

  it('prefers cf-connecting-ip over x-forwarded-for when both are present', () => {
    const req = makeReq('::1', {
      'cf-connecting-ip': '203.0.113.9',
      'x-forwarded-for': '198.51.100.7'
    });
    assert.strictEqual(getClientIp(req), '203.0.113.9');
  });

  it('an empty cf-connecting-ip header falls through to x-forwarded-for', () => {
    // Documented contract quirk: an empty header value is falsy, so the code
    // treats it the same as an absent header rather than as an empty IP.
    const req = makeReq('::1', { 'cf-connecting-ip': '', 'x-forwarded-for': '198.51.100.7' });
    assert.strictEqual(getClientIp(req), '198.51.100.7');
  });

  it('IGNORES spoofed proxy headers from a non-loopback peer (LAN client hitting :3000)', () => {
    const req = makeReq('192.168.4.50', {
      'cf-connecting-ip': '203.0.113.9',
      'x-forwarded-for': '198.51.100.7'
    });
    assert.strictEqual(getClientIp(req), '192.168.4.50');
  });

  it('a non-loopback IPv4-mapped peer is NOT trusted (only ::ffff:127.0.0.1 is)', () => {
    const req = makeReq('::ffff:192.168.4.50', { 'cf-connecting-ip': '203.0.113.9' });
    assert.strictEqual(getClientIp(req), '::ffff:192.168.4.50');
  });

  it('prefers req.ip (Express trust-proxy result) over the raw socket address', () => {
    const req = makeReq('192.168.4.50', {}, '192.168.4.99');
    assert.strictEqual(getClientIp(req), '192.168.4.99');
  });

  it('loopback peer with no proxy headers returns the peer address itself', () => {
    const req = makeReq('::1', {});
    assert.strictEqual(getClientIp(req), '::1');
  });

  it("returns 'unknown' when there is no ip and no socket at all", () => {
    assert.strictEqual(getClientIp({ headers: {} }), 'unknown');
  });
});

describe('normalizeForGate', () => {
  it('passes a plain protected path through, lowercased', () => {
    assert.strictEqual(normalizeForGate('/hls'), '/hls');
    assert.strictEqual(normalizeForGate('/HLS'), '/hls');
    assert.strictEqual(normalizeForGate('/HLS/Stream.M3U8'), '/hls/stream.m3u8');
  });

  it('collapses duplicate leading slashes (//hls)', () => {
    assert.strictEqual(normalizeForGate('//hls'), '/hls');
    assert.strictEqual(normalizeForGate('//hls//a.m3u8'), '/hls/a.m3u8');
  });

  it('decodes %-encoded slashes so /hls%2Ffile cannot slip the prefix check', () => {
    assert.strictEqual(normalizeForGate('/hls%2Ffile.m3u8'), '/hls/file.m3u8');
    assert.strictEqual(normalizeForGate('/hls%2ffile.m3u8'), '/hls/file.m3u8');
  });

  it('decodes %-encoded dot segments (/%2e%2e/hls)', () => {
    assert.strictEqual(normalizeForGate('/%2e%2e/hls'), '/hls');
  });

  it('converts backslashes to forward slashes (Windows-style separators)', () => {
    assert.strictEqual(normalizeForGate('\\hls\\x'), '/hls/x');
  });

  it('resolves .. traversal INTO a protected prefix (/foo/../hls/a.m3u8)', () => {
    assert.strictEqual(normalizeForGate('/foo/../hls/a.m3u8'), '/hls/a.m3u8');
    assert.strictEqual(normalizeForGate('/HLS/../foo'), '/foo');
  });

  it('resolves . and .. segments inside the path', () => {
    assert.strictEqual(normalizeForGate('/hls/./sub/../file'), '/hls/file');
  });

  it('traversal above the root clamps to root (matches express.static resolution)', () => {
    assert.strictEqual(normalizeForGate('/hls/../../etc'), '/etc');
    assert.strictEqual(normalizeForGate('/..'), '/');
  });

  it('keeps a malformed %-escape raw instead of throwing', () => {
    assert.strictEqual(normalizeForGate('/hls/%zz'), '/hls/%zz');
  });

  it("empty / missing paths normalize to '/'", () => {
    assert.strictEqual(normalizeForGate(''), '/');
    assert.strictEqual(normalizeForGate(undefined), '/');
    assert.strictEqual(normalizeForGate(null), '/');
  });
});
