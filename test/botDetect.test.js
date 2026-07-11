const { describe, it } = require('node:test');
const assert = require('node:assert');

const { isBot, isSuspicious } = require('../server/botDetect');

const CUBOT_UA = 'Mozilla/5.0 (Linux; Android 10; Cubot Note 20) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.72 Mobile Safari/537.36';
const CHROME_DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SAFARI_MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const IOS_WEBVIEW_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

describe('isBot', () => {
  describe('does not flag legitimate browsers/devices', () => {
    const legit = {
      'Cubot Android phone UA (Scunthorpe-style false positive)': CUBOT_UA,
      'Chrome desktop': CHROME_DESKTOP_UA,
      'Safari macOS': SAFARI_MAC_UA,
      'iOS WebView': IOS_WEBVIEW_UA
    };
    for (const [label, ua] of Object.entries(legit)) {
      it(`should allow ${label}`, () => {
        assert.strictEqual(isBot(ua), false);
      });
    }
  });

  describe('flags known tools and crawlers', () => {
    const bots = {
      'curl': 'curl/7.88.1',
      'python-requests': 'python-requests/2.31.0',
      'GPTBot': 'Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)',
      'HeadlessChrome': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36',
      'Googlebot': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
    };
    for (const [label, ua] of Object.entries(bots)) {
      it(`should block ${label}`, () => {
        assert.strictEqual(isBot(ua), true);
      });
    }
  });

  describe('boundary regex sanity for generic "bot" catch-all', () => {
    it('should block "bot/1.0"', () => {
      assert.strictEqual(isBot('bot/1.0'), true);
    });

    it('should block "MyBot crawler"', () => {
      assert.strictEqual(isBot('MyBot crawler'), true);
    });

    it('should NOT block "Cubot" (phone brand, not a bot)', () => {
      assert.strictEqual(isBot(CUBOT_UA), false);
    });

    it('should NOT block a "robotics" substring', () => {
      assert.strictEqual(isBot('Mozilla/5.0 RoboticsBrowser/1.0'), false);
    });
  });

  describe('missing user agent', () => {
    it('should treat empty string as bot', () => {
      assert.strictEqual(isBot(''), true);
    });

    it('should treat undefined as bot', () => {
      assert.strictEqual(isBot(undefined), true);
    });
  });
});

describe('isSuspicious', () => {
  it('should NOT flag a normal browser UA with only user-agent header set (WS upgrade case)', () => {
    const req = { headers: { 'user-agent': CHROME_DESKTOP_UA } };
    assert.strictEqual(isSuspicious(req), false);
  });

  it('should NOT flag a normal browser UA missing only accept-language', () => {
    const req = { headers: { 'user-agent': CHROME_DESKTOP_UA, accept: 'text/html' } };
    assert.strictEqual(isSuspicious(req), false);
  });

  it('should flag a short UA combined with missing accept-language (2 signals)', () => {
    const req = { headers: { 'user-agent': 'short-ua', accept: 'text/html' } };
    assert.strictEqual(isSuspicious(req), true);
  });

  it('should flag when all three signals are missing', () => {
    const req = { headers: {} };
    assert.strictEqual(isSuspicious(req), true);
  });

  it('should treat a missing user-agent header as an immediate bot verdict', () => {
    const req = { headers: { accept: 'text/html', 'accept-language': 'en-US' } };
    assert.strictEqual(isSuspicious(req), true);
  });
});
