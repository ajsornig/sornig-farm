const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const pending2fa = require('../server/pending-2fa');

// Controllable clock
let fakeNow = 1_000_000;
pending2fa._setNow(() => fakeNow);

beforeEach(() => {
  pending2fa._clear();
  fakeNow = 1_000_000;
});

after(() => {
  pending2fa._setNow(null);
  pending2fa._clear();
});

describe('pending-2fa store', () => {
  it('creates 64-hex tokens and check() returns the entry', () => {
    const token = pending2fa.create('drew');
    assert.match(token, /^[0-9a-f]{64}$/);
    const entry = pending2fa.check(token);
    assert.strictEqual(entry.usernameLower, 'drew');
    assert.strictEqual(entry.attempts, 0);
  });

  it('returns null for unknown or non-string tokens', () => {
    assert.strictEqual(pending2fa.check('deadbeef'.repeat(8)), null);
    assert.strictEqual(pending2fa.check(null), null);
    assert.strictEqual(pending2fa.check(undefined), null);
    assert.strictEqual(pending2fa.check({}), null);
  });

  it('expires entries after the TTL', () => {
    const token = pending2fa.create('drew');
    fakeNow += pending2fa.PENDING_TTL_MS; // exactly at TTL: still valid
    assert.ok(pending2fa.check(token));
    fakeNow += 1; // past TTL
    assert.strictEqual(pending2fa.check(token), null);
    assert.strictEqual(pending2fa.consume(token), null);
  });

  it('destroys the entry after MAX_ATTEMPTS failures', () => {
    const token = pending2fa.create('drew');
    for (let i = 0; i < pending2fa.MAX_ATTEMPTS - 1; i++) {
      pending2fa.recordFailure(token);
      assert.ok(pending2fa.check(token), `still alive after failure ${i + 1}`);
    }
    pending2fa.recordFailure(token); // 5th failure
    assert.strictEqual(pending2fa.check(token), null);
  });

  it('recordFailure on an unknown token is a no-op', () => {
    assert.doesNotThrow(() => pending2fa.recordFailure('nope'));
    assert.doesNotThrow(() => pending2fa.recordFailure(null));
  });

  it('consume is single-use', () => {
    const token = pending2fa.create('drew');
    const entry = pending2fa.consume(token);
    assert.strictEqual(entry.usernameLower, 'drew');
    assert.strictEqual(pending2fa.consume(token), null);
    assert.strictEqual(pending2fa.check(token), null);
  });

  it('evicts the oldest entry at the size cap', () => {
    const first = pending2fa.create('user0');
    for (let i = 1; i < pending2fa.MAX_ENTRIES; i++) {
      pending2fa.create(`user${i}`);
    }
    assert.strictEqual(pending2fa._size(), pending2fa.MAX_ENTRIES);
    assert.ok(pending2fa.check(first), 'oldest still present at cap');
    pending2fa.create('overflow');
    assert.strictEqual(pending2fa._size(), pending2fa.MAX_ENTRIES);
    assert.strictEqual(pending2fa.check(first), null, 'oldest evicted past cap');
  });

  it('tokens are unique per create', () => {
    const a = pending2fa.create('drew');
    const b = pending2fa.create('drew');
    assert.notStrictEqual(a, b);
    assert.ok(pending2fa.check(a) && pending2fa.check(b));
  });
});
