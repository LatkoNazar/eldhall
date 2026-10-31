import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

// Approved egress for "import from URL": the backend fetches only https pages on allow-listed
// hosts, never private/link-local/metadata addresses (checked at connect time, so DNS rebinding
// cannot slip through), never follows redirects to another host, and caps size and time.

export class EgressError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) { super(message); this.status = status; }
}

// Separate lists per family: one combined BlockList can match IPv6 addresses against IPv4 rules.
const blocked4 = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) {
  blocked4.addSubnet(network, prefix, 'ipv4');
}
const blocked6 = new BlockList();
for (const [network, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]] as const) {
  blocked6.addSubnet(network, prefix, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return isPublicAddress(mapped);
  if (family === 6 && /^::ffff:/i.test(address)) return false;   // hex-form IPv4-mapped: refuse rather than parse
  return family === 4 ? !blocked4.check(address, 'ipv4') : !blocked6.check(address, 'ipv6');
}

export function hostAllowed(hostname: string, allowlist: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return allowlist.some(pattern => {
    const p = pattern.toLowerCase();
    return p === host || (p.startsWith('*.') && host.endsWith(p.slice(1)) && host.length > p.length - 1);
  });
}

/** Static checks before any network call. */
export function checkUrl(raw: string, allowlist: string[]): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new EgressError('Not a valid URL'); }
  if (url.protocol !== 'https:') throw new EgressError('Only https:// sources can be imported');
  if (url.username || url.password) throw new EgressError('URLs with credentials are not allowed');
  if (url.port && url.port !== '443') throw new EgressError('Only the default https port is allowed');
  if (isIP(url.hostname.replace(/^\[|\]$/g, ''))) throw new EgressError('Use a hostname, not an IP address');
  if (!allowlist.length) throw new EgressError('URL import is disabled: KB_URL_ALLOWLIST is empty', 403);
  if (!hostAllowed(url.hostname, allowlist)) throw new EgressError(`Host ${url.hostname} is not on the knowledge-source allowlist`, 403);
  return url;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** dns.lookup that refuses non-public addresses; used as the socket's lookup, i.e. at connect time. */
export function safeLookup(hostname: string, options: object, callback: LookupCallback, resolve = dnsLookup): void {
  resolve(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '');
    const list = (Array.isArray(addresses) ? addresses : [{ address: addresses as unknown as string, family: 4 }]) as LookupAddress[];
    const bad = list.find(a => !isPublicAddress(a.address));
    if (!list.length || bad) return callback(Object.assign(new Error(`Refusing to connect to non-public address ${bad?.address ?? '(none)'}`), { code: 'EGRESS_BLOCKED' }), '');
    if ((options as { all?: boolean }).all) return callback(null, list);
    return callback(null, list[0]!.address, list[0]!.family);
  });
}

export interface FetchedPage { url: string; contentType: string; body: string }
export type PageFetcher = (url: URL) => Promise<FetchedPage>;

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 8000;
const TYPES = ['text/html', 'text/plain', 'text/markdown', 'application/xhtml+xml'];

/** Production fetcher: https only, connect-time IP check, at most 3 same-host redirects, 1 MB, 8 s. */
export function httpsFetcher(allowlist: string[]): PageFetcher {
  const fetchOnce = (url: URL, redirects: number): Promise<FetchedPage> => new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', lookup: safeLookup as never, timeout: TIMEOUT_MS, headers: { 'User-Agent': 'SupportCopilot-KB/1.0', Accept: TYPES.join(', ') } }, response => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirects >= 3) return reject(new EgressError('Too many redirects'));
        let next: URL;
        try { next = checkUrl(new URL(response.headers.location, url).toString(), allowlist); } catch (error) { return reject(error); }
        if (next.hostname !== url.hostname) return reject(new EgressError('Redirects to another host are not followed'));
        return resolve(fetchOnce(next, redirects + 1));
      }
      if (status !== 200) { response.resume(); return reject(new EgressError(`Source answered HTTP ${status}`, 502)); }
      const contentType = String(response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      if (!TYPES.includes(contentType)) { response.resume(); return reject(new EgressError(`Unsupported content type ${contentType || '(none)'}`, 415)); }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) { req.destroy(new EgressError('Source is larger than 1 MB', 413)); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try { resolve({ url: url.toString(), contentType, body: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) }); }
        catch { reject(new EgressError('Source is not valid UTF-8 text', 415)); }
      });
      response.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new EgressError('Source did not answer in time', 504)));
    req.on('error', error => reject(error instanceof EgressError ? error : new EgressError((error as NodeJS.ErrnoException).code === 'EGRESS_BLOCKED' ? error.message : 'Could not fetch the source', (error as NodeJS.ErrnoException).code === 'EGRESS_BLOCKED' ? 403 : 502)));
    req.end();
  });
  return url => fetchOnce(url, 0);
}
