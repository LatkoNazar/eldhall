import { timingSafeEqual } from 'node:crypto';

export function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!expected) return true;
  if (!header) return false;
  const match = /^Bearer (.+)$/i.exec(header);
  if (!match?.[1]) return false;
  const actual = Buffer.from(match[1]);
  const required = Buffer.from(expected);
  return actual.length === required.length && timingSafeEqual(actual, required);
}

export function hostAllowed(hostHeader: string | undefined, allowed: string[]): boolean {
  if (allowed.includes('*')) return true;
  if (!hostHeader || /[\s/@\\?#]/.test(hostHeader)) return false;
  let hostname: string;
  try { hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase(); } catch { return false; }
  return allowed.some(pattern => {
    const normalized = pattern.toLowerCase();
    return normalized === hostname || (normalized.startsWith('*.') && hostname.endsWith(normalized.slice(1)));
  });
}
