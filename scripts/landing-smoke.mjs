// Standalone: also executes through `node --input-type=module -` inside the API image.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';

const base = (process.env.SMOKE_BASE_URL || 'http://landing:8080').replace(/\/$/, '');

function request(path) {
  const url = new URL(base + path);
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      headers: { Host: process.env.SMOKE_HOST || url.host },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('Smoke HTTP request timed out')));
    req.end();
  });
}

function ok(response, label) {
  assert.equal(response.status, 200, `${label}: expected HTTP 200`);
  return response;
}

const index = ok(await request('/'), 'Landing index');
assert.match(index.headers['content-type'] || '', /text\/html/, 'Landing index is not HTML');
assert.match(index.headers['cache-control'] || '', /no-cache/, 'Landing index must revalidate');
const html = index.body.toString();
assert.match(html, /<h1(?:\s|>)/i, 'Landing heading is missing from HTML');
assert.match(html, /<a\b[^>]*\bdata-app-link(?:\s|=|>)/i, 'Landing app link is missing from HTML');
const selector = html.match(/<select\b[^>]*\bdata-language-picker\b[^>]*>([\s\S]*?)<\/select>/i)?.[1];
assert.ok(selector, 'Landing language selector is missing from HTML');
const locales = [...new Set([...selector.matchAll(/<option\b[^>]*\bvalue=["']([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)["']/g)].map(match => match[1]))];
for (const required of ['en', 'es', 'uk', 'de', 'pt']) assert.ok(locales.includes(required), 'Landing language option is missing');
const heading = document => document.match(/<h1(?:\s[^>]*)?>([\s\S]*?)<\/h1>/i)?.[1].replace(/<[^>]*>/g, '').trim();
for (const locale of locales) {
  const page = ok(await request(`/${locale}/`), 'Localized landing page');
  const content = page.body.toString();
  assert.match(page.headers['content-type'] || '', /text\/html/, 'Localized landing page is not HTML');
  assert.match(page.headers['cache-control'] || '', /no-cache/, 'Localized landing HTML must revalidate');
  assert.equal(content.match(/<html\b[^>]*\blang=["']([^"']+)["']/i)?.[1], locale, 'Localized landing page has the wrong language');
  assert.match(content, /<title\b[^>]*>[^<]+<\/title>/i, 'Localized landing title is missing');
  assert.match(content, /<meta\b(?=[^>]*\bname=["']description["'])(?=[^>]*\bcontent=["'][^"']+["'])[^>]*>/i, 'Localized landing description is missing');
  assert.ok(heading(content), 'Localized landing heading is missing');
  if (locale !== 'en') assert.notEqual(heading(content), heading(html), 'Localized landing page silently reused English content');
}
const assets = [...new Set([...html.matchAll(
  /\b(?:src|href)\s*=\s*["'](\/assets\/[^"']+)["']/g,
)].map((match) => match[1]))];
assert.ok(assets.length, 'Landing index contains no built assets');
for (const path of assets) {
  const asset = ok(await request(path), 'Landing asset');
  assert.ok(asset.body.length, 'Landing asset is empty');
  assert.doesNotMatch(asset.headers['content-type'] || '', /text\/html/, 'Landing asset returned HTML');
  assert.match(asset.headers['cache-control'] || '', /immutable/, 'Landing assets must be immutable');
}
ok(await request('/landing-health'), 'Landing health');
for (const path of ['/assets/missing-smoke-asset.js', '/landing-smoke-unknown-route', '/es/landing-smoke-unknown-route']) {
  assert.equal((await request(path)).status, 404, 'Unknown landing paths must return 404');
}
console.log('Landing smoke OK: localized static content, assets, health and true 404s');
