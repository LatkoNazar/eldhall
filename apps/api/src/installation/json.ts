/** Bounded callers supply text; reject ambiguous duplicate keys and deep JSON. */
export function parseInstallationJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  let cursor = 0;
  const whitespace = () => { while (cursor < text.length && /\s/.test(text[cursor]!)) cursor++; };
  const string = () => {
    const start = cursor++;
    while (text[cursor] !== '"') cursor += text[cursor] === '\\' ? 2 : 1;
    return JSON.parse(text.slice(start, ++cursor)) as string;
  };
  const value = (depth: number): void => {
    if (depth > 64) throw new Error('Installation JSON nesting limit');
    whitespace();
    if (text[cursor] === '{') {
      cursor++; whitespace(); const keys = new Set<string>();
      while (text[cursor] !== '}') {
        whitespace(); const key = string();
        if (keys.has(key)) throw new Error('Duplicate installation JSON key');
        keys.add(key); whitespace(); cursor++; value(depth + 1); whitespace(); if (text[cursor] === ',') cursor++;
      }
      cursor++;
    } else if (text[cursor] === '[') {
      cursor++; whitespace();
      while (text[cursor] !== ']') { value(depth + 1); whitespace(); if (text[cursor] === ',') cursor++; }
      cursor++;
    } else if (text[cursor] === '"') string();
    else while (cursor < text.length && !/[\s,}\]]/.test(text[cursor]!)) cursor++;
  };
  value(0);
  return parsed;
}
