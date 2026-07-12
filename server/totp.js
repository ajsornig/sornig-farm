// RFC 6238 TOTP (and RFC 4226 HOTP) implemented with node:crypto only —
// no external dependency, per this repo's minimal-dep posture.
const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1; // accept previous/current/next step (clock skew)
const SECRET_BYTES = 20; // 160-bit secret per RFC 4226 recommendation
const BACKUP_CODE_COUNT = 8;
const BACKUP_CODE_BYTES = 5; // 40 bits -> 8 base32 chars

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[=\s]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) {
      throw new Error(`Invalid base32 character: ${ch}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(keyBuf, counter, digits = TOTP_DIGITS) {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', keyBuf).update(counterBuf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binCode =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binCode % 10 ** digits).padStart(digits, '0');
}

// Returns { ok, step }. `step` is the accepted time-step so the caller can
// persist it as lastUsedStep — codes at or before lastUsedStep are rejected
// (replay protection).
function verifyTotp(secretBase32, code, options = {}) {
  const {
    now = Date.now(),
    step = TOTP_STEP_SECONDS,
    window = TOTP_WINDOW,
    lastUsedStep = 0,
    digits = TOTP_DIGITS,
  } = options;
  const normalized = String(code).replace(/\s/g, '');
  if (normalized.length !== digits || !/^\d+$/.test(normalized)) {
    return { ok: false, step: null };
  }
  const keyBuf = base32Decode(secretBase32);
  const currentStep = Math.floor(now / 1000 / step);
  for (let offset = -window; offset <= window; offset++) {
    const candidateStep = currentStep + offset;
    if (candidateStep <= lastUsedStep) continue;
    const expected = hotp(keyBuf, candidateStep, digits);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(normalized))) {
      return { ok: true, step: candidateStep };
    }
  }
  return { ok: false, step: null };
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(SECRET_BYTES));
}

function otpauthURI(issuer, account, secret) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params}`;
}

function normalizeBackupCode(code) {
  return String(code).toUpperCase().replace(/[^A-Z2-7]/g, '');
}

function hashBackupCode(code) {
  return crypto.createHash('sha256').update(normalizeBackupCode(code)).digest('hex');
}

// Returns { codes, hashes }: plaintext XXXX-XXXX codes shown to the user once,
// and the sha256 hashes to store at rest.
function generateBackupCodes(count = BACKUP_CODE_COUNT) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const raw = base32Encode(crypto.randomBytes(BACKUP_CODE_BYTES));
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}`);
  }
  return { codes, hashes: codes.map(hashBackupCode) };
}

module.exports = {
  base32Encode,
  base32Decode,
  hotp,
  verifyTotp,
  generateSecret,
  otpauthURI,
  normalizeBackupCode,
  hashBackupCode,
  generateBackupCodes,
  TOTP_STEP_SECONDS,
  TOTP_DIGITS,
  TOTP_WINDOW,
};
