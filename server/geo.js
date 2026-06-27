// Shared IP geolocation utility with an in-memory cache to avoid hammering
// the free ip-api.com endpoint for repeat visitors.
const geoCache = new Map();
const GEO_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

async function geolocateIP(ip) {
  // Skip localhost/private IPs
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
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

module.exports = { geolocateIP };
