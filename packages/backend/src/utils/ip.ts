/** Normalize IPv4-mapped IPv6 (::ffff:1.2.3.4) and strip a :port suffix. */
export function normalizeIp(raw: string): string {
  let ip = (raw || '').trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  // Strip an IPv4 :port (but never touch bare IPv6, which has many colons)
  const m = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (m) ip = m[1];
  return ip;
}
