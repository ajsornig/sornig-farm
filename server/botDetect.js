// Bot detection for the chat WebSocket handshake (see server/chat.js). A
// "bot" verdict does not block the connection — it only suppresses
// visitor-map recording and viewer counting — so we err toward fewer false
// positives and log every verdict so future tuning has real evidence.

// Minimum realistic browser User-Agent length; shorter is one suspicion signal.
const MIN_UA_LENGTH = 10;
// Number of suspicion signals required before a request is flagged (out of 3 possible).
const SUSPICION_THRESHOLD = 2;
// How much of the User-Agent to include in log lines, to keep logs readable.
const MAX_LOGGED_UA_LENGTH = 120;

// Automation/scripting tool User-Agents (curl, headless browsers, HTTP libs).
const TOOL_UA_PATTERNS = [
  /headless/i,
  /phantom/i,
  /selenium/i,
  /puppeteer/i,
  /playwright/i,
  /wget/i,
  /curl/i,
  /httpie/i,
  /python-requests/i,
  /python-urllib/i,
  /go-http-client/i,
  /java\//i,
  /libwww/i,
  /scrapy/i,
  /nutch/i
];

// Named search-engine / social-media / SEO crawler User-Agents, plus a
// boundary-safe generic "bot" catch-all. The boundary form avoids matching
// substrings like "Cubot" (a phone brand) or "robotics" while still catching
// "Googlebot", "bot/1.0", "MyBot", etc.
const CRAWLER_UA_PATTERNS = [
  /(?:^|[^a-z])bot(?:[^a-z]|$)/i,
  /crawler/i,
  /spider/i,
  /crawling/i,
  /googlebot/i,
  /bingbot/i,
  /yandex/i,
  /baidu/i,
  /duckduckbot/i,
  /slurp/i,
  /facebookexternalhit/i,
  /linkedinbot/i,
  /twitterbot/i,
  /whatsapp/i,
  /telegrambot/i,
  /discordbot/i,
  /applebot/i,
  /semrush/i,
  /ahrefs/i,
  /mj12bot/i,
  /dotbot/i,
  /petalbot/i,
  /bytespider/i,
  /gptbot/i,
  /claudebot/i,
  /anthropic/i
];

// Logs a bot verdict with its reason. Only called on a "bot"/"suspicious"
// verdict — passes are not logged, to keep the signal-to-noise high.
function logBlocked(reason, userAgent) {
  const truncated = (userAgent || '').slice(0, MAX_LOGGED_UA_LENGTH);
  console.log(`[botDetect] blocked: reason=${reason} ua="${truncated}"`);
}

function isBot(userAgent) {
  if (!userAgent) {
    logBlocked('empty-ua', userAgent);
    return true; // No user agent = suspicious
  }

  for (const pattern of TOOL_UA_PATTERNS) {
    if (pattern.test(userAgent)) {
      logBlocked(pattern, userAgent);
      return true;
    }
  }

  for (const pattern of CRAWLER_UA_PATTERNS) {
    if (pattern.test(userAgent)) {
      logBlocked(pattern, userAgent);
      return true;
    }
  }

  return false;
}

// Check for suspicious characteristics using a scoring model rather than a
// single hard rule — legitimate browser WebSocket UPGRADE requests often
// omit accept-language/accept, so any one missing signal alone is not
// enough to flag a request as suspicious.
function isSuspicious(req) {
  const ua = req.headers['user-agent'] || '';

  if (!ua) {
    logBlocked('empty-ua', ua);
    return true; // No user agent = immediate bot verdict
  }

  const missingAcceptLanguage = !req.headers['accept-language'];
  const missingAccept = !req.headers['accept'];

  // Missing accept-language and missing accept count as ONE combined signal,
  // not two: legitimate browser WebSocket upgrade requests routinely omit
  // both together, so double-counting them would hit the threshold on that
  // common, legitimate case alone. A short UA is the other, independent signal.
  const reasons = [];
  let score = 0;
  if (ua.length < MIN_UA_LENGTH) {
    score++;
    reasons.push('short-ua');
  }
  if (missingAcceptLanguage || missingAccept) {
    score++;
    if (missingAcceptLanguage) reasons.push('no-accept-language');
    if (missingAccept) reasons.push('no-accept');
  }

  const suspicious = score >= SUSPICION_THRESHOLD;
  if (suspicious) {
    logBlocked(`suspicious(${reasons.join(',')})`, ua);
  }

  return suspicious;
}

module.exports = {
  isBot,
  isSuspicious
};
