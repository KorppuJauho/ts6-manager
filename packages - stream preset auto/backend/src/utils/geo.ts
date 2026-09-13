import geoip from 'geoip-lite';

export interface GeoResult {
  country: string | null; // ISO 3166-1 alpha-2
  isPrivate: boolean;
}

/** Normalize IPv4-mapped IPv6 (::ffff:1.2.3.4) and strip a :port suffix. */
function normalizeIp(raw: string): string {
  let ip = (raw || '').trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  // Strip an IPv4 :port (but never touch bare IPv6, which has many colons)
  const m = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (m) ip = m[1];
  return ip;
}

function isPrivateIp(ip: string): boolean {
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true; // link-local
  if (/^(fc|fd)[0-9a-f]{2}:/i.test(ip)) return true; // unique local IPv6
  if (/^fe80:/i.test(ip)) return true; // link-local IPv6
  return false;
}

export function lookupCountry(rawIp: string): GeoResult {
  const ip = normalizeIp(rawIp);
  if (!ip) return { country: null, isPrivate: false };
  if (isPrivateIp(ip)) return { country: null, isPrivate: true };
  try {
    const geo = geoip.lookup(ip);
    return { country: geo?.country || null, isPrivate: false };
  } catch {
    return { country: null, isPrivate: false };
  }
}

export { normalizeIp };
