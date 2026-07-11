const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  base32Encode,
  base32Decode,
  hotp,
  verifyTotp,
  generateSecret,
  otpauthURI,
  normalizeBackupCode,
  hashBackupCode,
  generateBackupCodes,
} = require('../server/totp');

// RFC 6238 Appendix B secret: ASCII "12345678901234567890"
const RFC6238_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('base32 (RFC 4648)', () => {
  const vectors = [
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];

  it('encodes the RFC 4648 test vectors (unpadded)', () => {
    for (const [plain, encoded] of vectors) {
      assert.strictEqual(base32Encode(Buffer.from(plain)), encoded);
    }
  });

  it('decodes the RFC 4648 test vectors', () => {
    for (const [plain, encoded] of vectors) {
      assert.strictEqual(base32Decode(encoded).toString(), plain);
    }
  });

  it('decodes with padding, whitespace, and lowercase', () => {
    assert.strictEqual(base32Decode('MY======').toString(), 'f');
    assert.strictEqual(base32Decode('mzxw6ytboi').toString(), 'foobar');
    assert.strictEqual(base32Decode('MZXW 6YTB OI').toString(), 'foobar');
  });

  it('rejects invalid characters', () => {
    assert.throws(() => base32Decode('MZXW1'), /Invalid base32/); // '1' not in alphabet
    assert.throws(() => base32Decode('MZXW!'), /Invalid base32/);
  });

  it('round-trips the RFC 6238 secret', () => {
    assert.strictEqual(
      base32Decode(RFC6238_SECRET_B32).toString(),
      '12345678901234567890'
    );
    assert.strictEqual(
      base32Encode(Buffer.from('12345678901234567890')),
      RFC6238_SECRET_B32
    );
  });
});

describe('TOTP (RFC 6238 Appendix B, SHA-1, 8 digits)', () => {
  const key = Buffer.from('12345678901234567890');
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  it('hotp matches all Appendix B vectors', () => {
    for (const [t, expected] of vectors) {
      const counter = Math.floor(t / 30);
      assert.strictEqual(hotp(key, counter, 8), expected);
    }
  });

  it('verifyTotp accepts the Appendix B codes at their timestamps', () => {
    for (const [t, expected] of vectors) {
      const result = verifyTotp(RFC6238_SECRET_B32, expected, {
        now: t * 1000,
        digits: 8,
      });
      assert.strictEqual(result.ok, true, `T=${t}`);
      assert.strictEqual(result.step, Math.floor(t / 30));
    }
  });
});

describe('verifyTotp window and replay', () => {
  const NOW = 1111111111 * 1000; // step 37037037
  const codeAt = (step) =>
    hotp(Buffer.from('12345678901234567890'), step, 6);
  const currentStep = Math.floor(1111111111 / 30);

  it('accepts current, previous, and next step codes (window 1)', () => {
    for (const offset of [-1, 0, 1]) {
      const result = verifyTotp(RFC6238_SECRET_B32, codeAt(currentStep + offset), {
        now: NOW,
      });
      assert.strictEqual(result.ok, true, `offset ${offset}`);
      assert.strictEqual(result.step, currentStep + offset);
    }
  });

  it('rejects codes two steps away', () => {
    for (const offset of [-2, 2]) {
      const result = verifyTotp(RFC6238_SECRET_B32, codeAt(currentStep + offset), {
        now: NOW,
      });
      assert.strictEqual(result.ok, false, `offset ${offset}`);
    }
  });

  it('rejects replay of an already-used step', () => {
    const first = verifyTotp(RFC6238_SECRET_B32, codeAt(currentStep), { now: NOW });
    assert.strictEqual(first.ok, true);
    const replay = verifyTotp(RFC6238_SECRET_B32, codeAt(currentStep), {
      now: NOW,
      lastUsedStep: first.step,
    });
    assert.strictEqual(replay.ok, false);
  });

  it('still accepts the NEXT step after one is used', () => {
    const first = verifyTotp(RFC6238_SECRET_B32, codeAt(currentStep), { now: NOW });
    const next = verifyTotp(RFC6238_SECRET_B32, codeAt(currentStep + 1), {
      now: NOW,
      lastUsedStep: first.step,
    });
    assert.strictEqual(next.ok, true);
  });

  it('rejects malformed codes without throwing', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 5x', null, undefined]) {
      assert.strictEqual(verifyTotp(RFC6238_SECRET_B32, bad, { now: NOW }).ok, false);
    }
  });

  it('accepts codes with internal whitespace (paste from authenticator)', () => {
    const code = codeAt(currentStep);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    assert.strictEqual(verifyTotp(RFC6238_SECRET_B32, spaced, { now: NOW }).ok, true);
  });
});

describe('generateSecret / otpauthURI', () => {
  it('generates 32-char base32 secrets that decode to 20 bytes', () => {
    const secret = generateSecret();
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.strictEqual(base32Decode(secret).length, 20);
  });

  it('generates unique secrets', () => {
    assert.notStrictEqual(generateSecret(), generateSecret());
  });

  it('builds a well-formed otpauth URI with encoded label', () => {
    const uri = otpauthURI('Sornig Farm', 'drew', 'ABC234');
    assert.ok(uri.startsWith('otpauth://totp/Sornig%20Farm:drew?'));
    assert.ok(uri.includes('secret=ABC234'));
    assert.ok(uri.includes('issuer=Sornig+Farm') || uri.includes('issuer=Sornig%20Farm'));
    assert.ok(uri.includes('algorithm=SHA1'));
    assert.ok(uri.includes('digits=6'));
    assert.ok(uri.includes('period=30'));
  });
});

describe('backup codes', () => {
  it('generates 8 codes in XXXX-XXXX base32 format with matching hashes', () => {
    const { codes, hashes } = generateBackupCodes();
    assert.strictEqual(codes.length, 8);
    assert.strictEqual(hashes.length, 8);
    for (let i = 0; i < codes.length; i++) {
      assert.match(codes[i], /^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
      assert.strictEqual(hashBackupCode(codes[i]), hashes[i]);
    }
  });

  it('hashing is insensitive to case, dashes, and spaces', () => {
    const code = 'AB2D-EF3G';
    assert.strictEqual(hashBackupCode('ab2d ef3g'), hashBackupCode(code));
    assert.strictEqual(hashBackupCode('ab2def3g'), hashBackupCode(code));
    assert.strictEqual(normalizeBackupCode(' ab2d-ef3g '), 'AB2DEF3G');
  });

  it('different codes hash differently', () => {
    const { hashes } = generateBackupCodes();
    assert.strictEqual(new Set(hashes).size, hashes.length);
  });
});
