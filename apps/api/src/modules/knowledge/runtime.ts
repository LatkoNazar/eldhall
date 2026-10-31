import { checkUrl, EgressError, httpsFetcher, type PageFetcher } from './egress.js';
import { KnowledgeRetriever } from './retriever.js';
import { htmlToMarkdown, normalizeText } from './text.js';

/**
 * Process-wide knowledge runtime shared by the harness and the operator routes. createSupport()
 * replaces it from Settings (embedder, pgvector, URL allowlist); tests may inject their own.
 */
export const knowledgeRuntime: { retriever: KnowledgeRetriever; urlAllowlist: string[]; fetcher: PageFetcher } = {
  retriever: new KnowledgeRetriever(),
  urlAllowlist: [],
  fetcher: httpsFetcher([]),
};

export function configureKnowledge(next: Partial<typeof knowledgeRuntime>): void {
  Object.assign(knowledgeRuntime, next);
  if (next.urlAllowlist && !next.fetcher) knowledgeRuntime.fetcher = httpsFetcher(next.urlAllowlist);
}

export class KnowledgeImportError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface ImportedDocument { title: string; content: string; sourceUrl: string | null }

/** Fetches an allow-listed https page (SSRF-checked at connect time) and converts it to Markdown. */
export async function importFromUrl(raw: string, title?: string): Promise<ImportedDocument> {
  let url: URL;
  try { url = checkUrl(raw, knowledgeRuntime.urlAllowlist); } catch (error) {
    if (error instanceof EgressError) throw new KnowledgeImportError(error.status, error.message);
    throw error;
  }
  let page;
  try { page = await knowledgeRuntime.fetcher(url); } catch (error) {
    if (error instanceof EgressError) throw new KnowledgeImportError(error.status, error.message);
    throw new KnowledgeImportError(502, 'Could not fetch the source');
  }
  const content = page.contentType.includes('html') ? htmlToMarkdown(page.body) : normalizeText(page.body);
  if (!content) throw new KnowledgeImportError(422, 'The page has no readable text');
  const name = title?.trim() || /<title[^>]*>([^<]{1,200})<\/title>/i.exec(page.body)?.[1]?.trim() || /^#\s+(.+)$/m.exec(content)?.[1]?.trim() || url.hostname;
  return { title: name.slice(0, 200), content, sourceUrl: page.url };
}

const UPLOAD_TYPES: Record<string, 'markdown' | 'text' | 'html'> = { md: 'markdown', markdown: 'markdown', txt: 'text', html: 'html', htm: 'html' };

/** A .md/.txt/.html file (base64, ≤ 512 KB, UTF-8) as Markdown. PDF/DOCX must be exported first. */
export function importFromFile(filename: string, contentBase64: string, title?: string): ImportedDocument {
  const extension = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? '';
  if (extension === 'pdf' || extension === 'docx') throw new KnowledgeImportError(415, `.${extension} files are not supported yet: export the document as Markdown, text or HTML`);
  const format = UPLOAD_TYPES[extension];
  if (!format) throw new KnowledgeImportError(415, 'Supported files: .md, .txt, .html');
  const bytes = Buffer.from(contentBase64, 'base64');
  if (!bytes.length) throw new KnowledgeImportError(422, 'The file is empty');
  if (bytes.length > 512 * 1024) throw new KnowledgeImportError(413, 'File is larger than 512 KB');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new KnowledgeImportError(415, 'File is not valid UTF-8 text'); }
  const content = format === 'html' ? htmlToMarkdown(text) : normalizeText(text);
  if (!content) throw new KnowledgeImportError(422, 'The file has no readable text');
  const name = title?.trim() || /^#\s+(.+)$/m.exec(content)?.[1]?.trim() || filename.replace(/\.[^.]+$/, '');
  return { title: name.slice(0, 200), content, sourceUrl: null };
}
