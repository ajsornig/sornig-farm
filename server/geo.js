// Shared IP geolocation utility with an in-memory cache to avoid hammering
// the free ip-api.com endpoint for repeat visitors.
const geoCache = new Map();
const GEO_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

function isPrivateIP(ip) {
  return (
    ip === '::1' ||
    ip.startsWith('127.') ||
    ip.startsWith('192.168.') ||
    ip.startsWith('10.') ||
    ip.startsWith('169.254.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

async function geolocateIP(rawIp) {
  if (!rawIp) return null;
  // Node reports IPv4 clients as IPv4-mapped IPv6 (::ffff:1.2.3.4); strip the
  // prefix so private-range checks and the lookup see the plain IPv4 form.
  const ip = rawIp.replace(/^::ffff:/i, '');
  // Skip localhost/private IPs
  if (isPrivateIP(ip)) {
    return null;
  }

  const cached = geoCache.get(ip);
  if (cached && Date.now() - cached.timestamp < GEO_CACHE_TTL) {
    return cached.data;
  }

  try {
    const response = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,city,lat,lon`);
    const data = await response.json();
    if (data.status === 'success') {
      const result = { city: data.city, country: data.country, lat: data.lat, lng: data.lon };
      geoCache.set(ip, { data: result, timestamp: Date.now() });
      return result;
    }
  } catch (err) {
    console.error('Geolocation failed:', err.message);
  }
  return null;
}

module.exports = { geolocateIP, isPrivateIP };
