const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// db.js requires visited-locations.js; point that store at a throwaway temp
// file BEFORE the require chain loads, so nothing in this test can ever touch
// the live data/visited-locations.json. (hashPassword/verifyPassword are pure
// crypto and never read data.json — initDb is deliberately not called here.)
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-'));
process.env.VISITED_LOCATIONS_FILE = path.join(tempDir, 'visited-locations.json');

const { hashPassword, verifyPassword } = require('../server/db');

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('hashPassword', () => {
  it('produces a scrypt:<salt>:<hash> string with hex salt and hash', () => {
    const stored = hashPassword('correct horse battery staple');
    assert.match(stored, /^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/);
  });

  it('salts every hash — same password twice yields different stored values', () => {
    const a = hashPassword('same-password');
    const b = hashPassword('same-password');
    assert.notStrictEqual(a, b);
    // Both must still verify.
    assert.strictEqual(verifyPassword('same-password', a), true);
    assert.strictEqual(verifyPassword('same-password', b), true);
  });
});

describe('verifyPassword', () => {
  it('round-trips: the hashed password verifies', () => {
    const stored = hashPassword('hunter22-but-longer');
    assert.strictEqual(verifyPassword('hunter22-but-longer', stored), true);
  });

  it('rejects the wrong password', () => {
    const stored = hashPassword('the-real-password');
    assert.strictEqual(verifyPassword('the-wrong-password', stored), false);
    assert.strictEqual(verifyPassword('', stored), false);
    assert.strictEqual(verifyPassword('the-real-password ', stored), false); // trailing space matters
  });

  it('rejects a tampered scrypt hash of the correct length', () => {
    const stored = hashPassword('tamper-me');
    const lastChar = stored.slice(-1);
    const flipped = stored.slice(0, -1) + (lastChar === '0' ? '1' : '0');
    assert.strictEqual(verifyPassword('tamper-me', flipped), false);
  });

  it('still verifies a legacy unsalted SHA-256 hash', () => {
    // Constructed exactly the way the pre-scrypt code stored passwords:
    // hex SHA-256 of the raw password, no salt, no prefix.
    const legacy = crypto.createHash('sha256').update('old-password-123').digest('hex');
    assert.strictEqual(verifyPassword('old-password-123', legacy), true);
    assert.strictEqual(verifyPassword('not-the-password', legacy), false);
  });

  it('returns false (not throw) for scrypt entries with missing parts', () => {
    assert.strictEqual(verifyPassword('pw', 'scrypt:'), false);          // no salt, no hash
    assert.strictEqual(verifyPassword('pw', 'scrypt:abcdef'), false);    // salt only
    assert.strictEqual(verifyPassword('pw', 'scrypt::deadbeef'), false); // empty salt
    assert.strictEqual(verifyPassword('pw', 'scrypt:abcdef:'), false);   // empty hash
  });

  it('returns false (not throw) for empty or short legacy-shaped values', () => {
    assert.strictEqual(verifyPassword('pw', ''), false);
    assert.strictEqual(verifyPassword('pw', 'not-a-hash'), false);
  });

  it('returns false (not throw) for non-string stored values', () => {
    assert.strictEqual(verifyPassword('pw', null), false);
    assert.strictEqual(verifyPassword('pw', undefined), false);
    assert.strictEqual(verifyPassword('pw', 12345), false);
    assert.strictEqual(verifyPassword('pw', { hash: 'x' }), false);
    assert.strictEqual(verifyPassword('pw', ['scrypt', 'a', 'b']), false);
  });
});
