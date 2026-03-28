/**
 * geoip.js
 * Lightweight GeoIP country lookup via ipapi.co (free tier: ~1k req/day).
 * Used only for premium users who enable location filtering.
 */

const fetch = require('node-fetch');

const CACHE = new Map(); // ip → { country, ts }
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Returns the 2-letter ISO country code for an IP address.
 * Returns null on failure (rate limit, network error, etc.).
 * @param {string} ip
 * @returns {Promise<string|null>}
 */
async function getCountry(ip) {
  // Skip loopback / private addresses
  if (!ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('192.168.') || ip.startsWith('10.')) {
    return 'LOCAL';
  }

  const cached = CACHE.get(ip);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.country;
  }

  try {
    const res = await fetch(`https://ipapi.co/${ip}/country/`, { timeout: 3000 });
    if (!res.ok) return null;
    const country = (await res.text()).trim().toUpperCase();
    if (country.length !== 2) return null;

    CACHE.set(ip, { country, ts: Date.now() });
    return country;
  } catch {
    return null;
  }
}

module.exports = { getCountry };
