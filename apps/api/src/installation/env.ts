// Consumer: Docker Compose --env-file only, not Node util.parseEnv or a shell.
const header = '# Eldhall Compose-only environment; do not source or parse with Node dotenv.\n';
const keyPattern = /^[A-Z][A-Z0-9_]{0,99}$/;
export function literalValue(value: string): boolean {
  if (Buffer.byteLength(value) > 16_384 || Buffer.from(value).toString('utf8') !== value) return false;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029) return false;
  }
  return true;
}
const quoted = (value: string) => JSON.stringify(value).replace(/\$/g, '\\$');
export function encodeComposeEnvironment(values: Record<string, string>): string {
  const lines = Object.keys(values).sort().map(key => {
    if (!keyPattern.test(key) || !literalValue(values[key]!)) throw new Error('Unsupported environment value');
    return `${key}=${quoted(values[key]!)}`;
  });
  const text = header + lines.join('\n') + '\n';
  if (Buffer.byteLength(text) > 65_536) throw new Error('Environment exceeds limit');
  return text;
}
export function decodeGeneratedEnvironment(text: string): Record<string, string> {
  if (Buffer.byteLength(text) > 65_536 || !text.startsWith(header) || !text.endsWith('\n')) throw new Error('Invalid generated environment');
  const values: Record<string, string> = {};
  for (const line of text.slice(header.length, -1).split('\n')) {
    const split = line.indexOf('='), key = line.slice(0, split), encoded = line.slice(split + 1);
    if (split < 1 || !keyPattern.test(key) || Object.hasOwn(values, key)) throw new Error('Invalid generated environment');
    const value: unknown = JSON.parse(encoded.replace(/\\\$/g, '$'));
    if (typeof value !== 'string' || !literalValue(value)) throw new Error('Invalid generated environment');
    values[key] = value;
  }
  if (encodeComposeEnvironment(values) !== text) throw new Error('Noncanonical generated environment');
  return values;
}
