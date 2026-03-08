// Known bot user agent patterns
const botPatterns = [
  /bot/i,
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
  /anthropic/i,
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
  /nutch/i,
  /archive/i,
  /preview/i,
  /fetch/i,
  /check/i,
  /monitor/i,
  /scan/i,
  /probe/i
];

function isBot(userAgent) {
  if (!userAgent) return true; // No user agent = suspicious

  for (const pattern of botPatterns) {
    if (pattern.test(userAgent)) {
      return true;
    }
  }

  return false;
}

// Check for suspicious characteristics
function isSuspicious(req) {
  const ua = req.headers['user-agent'] || '';

  // No user agent
  if (!ua) return true;

  // Very short user agent (bots often have minimal UA)
  if (ua.length < 20) return true;

  // Missing typical browser headers
  if (!req.headers['accept-language'] && !req.headers['accept']) {
    return true;
  }

  return false;
}

module.exports = {
  isBot,
  isSuspicious
};
