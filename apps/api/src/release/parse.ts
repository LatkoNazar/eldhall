import { releaseManifestSchema } from './manifest.js';

/** JSON.parse alone silently accepts duplicate keys, including escaped spellings. */
export function parseReleaseManifest(text: string) {
  if (Buffer.byteLength(text, 'utf8') > 4_000_000) throw new Error('Release manifest exceeds size limit');
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; }
  catch { throw new Error('Release manifest is not valid JSON'); }
  let cursor = 0;
  const whitespace = () => { while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++; };
  const string = (): string => {
    const start = cursor++;
    while (text[cursor] !== '"') cursor += text[cursor] === '\\' ? 2 : 1;
    return JSON.parse(text.slice(start, ++cursor)) as string;
  };
  const value = (depth: number): void => {
    if (depth > 64) throw new Error('Release manifest exceeds nesting limit');
    whitespace();
    if (text[cursor] === '{') {
      cursor++;
      whitespace();
      const keys = new Set<string>();
      while (text[cursor] !== '}') {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new Error('Release manifest contains a duplicate JSON key');
        keys.add(key);
        whitespace();
        cursor++; // Colon: syntax has already been checked by JSON.parse.
        value(depth + 1);
        whitespace();
        if (text[cursor] === ',') cursor++;
      }
      cursor++;
    } else if (text[cursor] === '[') {
      cursor++;
      whitespace();
      while (text[cursor] !== ']') {
        value(depth + 1);
        whitespace();
        if (text[cursor] === ',') cursor++;
      }
      cursor++;
    } else if (text[cursor] === '"') string();
    else while (cursor < text.length && !/[\s,}\]]/.test(text[cursor]!)) cursor++;
  };
  value(0);
  return releaseManifestSchema.parse(parsed);
}
