import { createHash } from 'node:crypto';

// Pure, deterministic text processing shared by the retriever: normalisation, heading-aware
// chunking and UA/EN search terms (light stemming + domain synonyms). No network, no model calls.

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g;

/** NFKC, LF line endings, no zero-width/bidi characters, no trailing spaces, at most one blank line. */
export function normalizeText(raw: string): string {
  return raw.normalize('NFKC').replace(/\r\n?/g, '\n').replace(INVISIBLE, '').replace(/\t/g, '  ')
    .split('\n').map(line => line.replace(/\s+$/u, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', laquo: '«', raquo: '»', hellip: '…' };

/** Readable markdown from an HTML page: headings, paragraphs and list items survive; scripts, styles and chrome do not. */
export function htmlToMarkdown(html: string): string {
  const main = /<main[\s\S]*?<\/main>/i.exec(html)?.[0] ?? /<article[\s\S]*?<\/article>/i.exec(html)?.[0] ?? /<body[\s\S]*?<\/body>/i.exec(html)?.[0] ?? html;
  const text = main
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg|iframe|nav|header|footer|form|aside)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) => `\n\n${'#'.repeat(Math.min(Number(level) + 1, 4))} ${inner}\n\n`)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|ul|ol|table|tr|li|blockquote)>/gi, '\n\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
      if (code.startsWith('#x')) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
      if (code.startsWith('#')) return String.fromCodePoint(Number(code.slice(1)));
      return ENTITIES[code.toLowerCase()] ?? entity;
    });
  return normalizeText(text.split('\n').map(line => line.replace(/[ \u00A0]{2,}/g, ' ').trim()).join('\n'));
}

export interface ChunkDraft { ord: number; headingPath: string; body: string; contentHash: string; terms: string[] }

const MAX_CHARS = 900;
const MIN_CHARS = 60;

/**
 * Splits markdown by ## / ### headings. A section longer than MAX_CHARS is split on paragraph
 * boundaries (the last sentence is repeated as overlap); a section shorter than MIN_CHARS is merged
 * into the next one so a heading never stands alone.
 */
export function chunkMarkdown(title: string, markdown: string): ChunkDraft[] {
  const sections: { path: string[]; lines: string[] }[] = [];
  let path: string[] = [];
  let current = { path: [] as string[], lines: [] as string[] };
  for (const line of markdown.split('\n')) {
    const heading = /^(#{1,4})\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      if (current.lines.join('').trim()) sections.push(current);
      const level = heading[1]!.length;
      // "# Title" is the document title; deeper levels build the path below it.
      path = level <= 1 ? [] : [...path.slice(0, Math.max(0, level - 2)), heading[2]!];
      current = { path, lines: [] };
    } else current.lines.push(line);
  }
  if (current.lines.join('').trim()) sections.push(current);

  const merged: { path: string[]; text: string }[] = [];
  let carry: { path: string[]; text: string } | null = null;
  for (const section of sections) {
    const text = normalizeText(section.lines.join('\n'));
    // A short section is folded into the next one under the next one's heading; its own heading stays in the text.
    const piece: { path: string[]; text: string } = carry
      ? { path: section.path.length ? section.path : carry.path, text: `${carry.path.length && carry.path.join() !== section.path.join() ? `${carry.path.at(-1)}: ` : ''}${carry.text}\n\n${text}` }
      : { path: section.path, text };
    if (piece.text.length < MIN_CHARS) { carry = piece; continue; }
    carry = null;
    merged.push(piece);
  }
  if (carry) {
    const last = merged.at(-1);
    if (last && last.text.length + carry.text.length <= MAX_CHARS) last.text += `\n\n${carry.text}`;
    else merged.push(carry);
  }

  const out: ChunkDraft[] = [];
  for (const section of merged) {
    const headingPath = [title, ...section.path].join(' › ');
    for (const body of splitLong(section.text)) {
      out.push({ ord: out.length, headingPath, body, contentHash: sha256(`${headingPath}\n${body}`), terms: terms(`${headingPath}\n${body}`) });
    }
  }
  return out;
}

function splitLong(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];
  const parts: string[] = [];
  let buffer = '';
  for (const paragraph of text.split(/\n{2,}/)) {
    for (const piece of paragraph.length > MAX_CHARS ? paragraph.split(/(?<=[.!?…])\s+/u) : [paragraph]) {
      if (buffer && buffer.length + piece.length + 2 > MAX_CHARS) {
        parts.push(buffer);
        const overlap = /[^.!?…]+[.!?…]\s*$/u.exec(buffer)?.[0]?.trim() ?? '';
        buffer = overlap.length < 200 ? overlap : '';
      }
      buffer = buffer ? `${buffer}\n\n${piece}` : piece;
    }
  }
  if (buffer) parts.push(buffer);
  return parts;
}

// ---------- Terms: shared by lexical search, the local embedder and the Postgres tsvector ----------

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'be', 'it', 'my', 'me', 'i', 'you', 'your', 'we', 'our', 'this', 'that', 'with', 'at', 'by', 'from', 'as', 'do', 'does', 'can', 'please', 'hi', 'hello',
  'і', 'й', 'та', 'а', 'але', 'в', 'у', 'на', 'з', 'із', 'зі', 'до', 'по', 'за', 'від', 'для', 'про', 'що', 'як', 'це', 'ця', 'цей', 'ці', 'є', 'не', 'ні', 'так', 'чи', 'я', 'ви', 'вас', 'вам', 'мене', 'мені', 'ми', 'нас', 'він', 'вона', 'вони', 'їх', 'його', 'її', 'же', 'ж', 'б', 'би', 'вже', 'ще', 'будь', 'ласка', 'привіт', 'добрий', 'день',
]);

// Ukrainian and English inflection endings, longest first. Deliberately light: a stem only needs
// to be stable for search, not linguistically correct.
const SUFFIXES = [
  'ування', 'ювання', 'ення', 'ання', 'іння', 'ями', 'ами', 'ові', 'еві', 'ого', 'ому', 'ими', 'іми', 'ого', 'ний', 'ної', 'ною', 'них', 'ним', 'ною',
  'ться', 'тися', 'ити', 'ати', 'яти', 'іти', 'ути', 'ете', 'ємо', 'имо', 'ють', 'ять', 'али', 'или', 'ала', 'ила', 'ало', 'ило',
  'ий', 'ій', 'ої', 'ою', 'ею', 'ів', 'их', 'ім', 'ам', 'ям', 'ах', 'ях', 'ом', 'ем', 'ла', 'ли', 'ло', 'ть',
  'ings', 'ing', 'ied', 'ies', 'ed', 'es', 's',
  'а', 'я', 'у', 'ю', 'і', 'и', 'е', 'о', 'ь', 'ї', 'є',
];

export function stem(word: string): string {
  if (word.length <= 3 || /\d/.test(word)) return word;
  for (const suffix of SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) return word.slice(0, -suffix.length);
  }
  return word;
}

// Domain synonyms (UA/EN). Every word of a group maps to the group's canonical term, so
// "двічі", "duplicate" and "twice" meet in the same index slot for both lexical and vector search.
const SYNONYM_GROUPS: Record<string, string[]> = {
  duplicate: ['duplicate', 'duplicated', 'twice', 'double', 'doubled', 'двічі', 'подвійне', 'подвійний', 'подвійно', 'дубль', 'дублікат', 'повторне', 'повторно', 'дублювання'],
  refund: ['refund', 'refunds', 'refunded', 'reimburse', 'reimbursement', 'повернення', 'повернути', 'поверніть', 'повернуть', 'повернули', 'відшкодування', 'відшкодувати'],
  charge: ['charge', 'charged', 'charges', 'payment', 'payments', 'debit', 'debited', 'transaction', 'списання', 'списали', 'списав', 'списала', 'списують', 'оплата', 'оплати', 'платіж', 'платежу', 'платежі', 'транзакція'],
  cancel: ['cancel', 'cancelled', 'canceled', 'cancellation', 'unsubscribe', 'скасувати', 'скасування', 'скасуйте', 'скасував', 'відписатися', 'відписка', 'відмовитися'],
  subscription: ['subscription', 'membership', 'підписка', 'підписку', 'підписки', 'абонемент'],
  plan: ['plan', 'plans', 'tariff', 'тариф', 'тарифи', 'план', 'плану'],
  price: ['price', 'prices', 'cost', 'costs', 'fee', 'uah', 'грн', 'гривень', 'ціна', 'ціни', 'вартість', 'коштує', 'коштуватиме', 'скільки'],
  premium: ['premium', 'преміум', 'преміум-план'],
  basic: ['basic', 'базовий', 'бейсік', 'бейсик'],
  timeline: ['days', 'long', 'долго', 'термін', 'строк', 'строки', 'днів', 'дні', 'чекати', 'надійдуть', 'надходять', 'arrive'],
  annual: ['annual', 'yearly', 'year', 'річний', 'річного', 'рік', 'річна'],
  monthly: ['monthly', 'month', 'місячний', 'місяць', 'щомісяця', 'щомісячний'],
  delivery: ['delivery', 'shipping', 'courier', 'доставка', 'доставки', 'кур\'єр'],
  order: ['order', 'orders', 'замовлення'],
  account: ['login', 'password', 'account', 'пароль', 'вхід', 'увійти', 'акаунт', 'кабінет'],
  invoice: ['invoice', 'receipt', 'рахунок', 'квитанція', 'чек'],
  specialist: ['specialist', 'agent', 'human', 'operator', 'спеціаліст', 'оператор', 'людина', 'менеджер'],
  limit: ['limit', 'maximum', 'ліміт', 'максимум', 'понад'],
};

const CANONICAL = new Map<string, string>();
for (const [canonical, words] of Object.entries(SYNONYM_GROUPS)) {
  for (const word of words) for (const token of rawTokens(word)) CANONICAL.set(stem(token), canonical);
}

function rawTokens(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().replace(/[’ʼ`]/g, "'").match(/[\p{L}\p{N}']+/gu)?.map(t => t.replace(/^'+|'+$/g, '')).filter(Boolean) ?? [];
}

/** Search terms: lower-case, stop words removed, stemmed, synonyms canonicalised. Order and duplicates are kept (term frequency). */
export function terms(text: string): string[] {
  const out: string[] = [];
  for (const token of rawTokens(text)) {
    if (STOPWORDS.has(token) || token.length < 2) continue;
    const stemmed = stem(token);
    out.push(CANONICAL.get(stemmed) ?? stemmed);
  }
  return out;
}

