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
for (const path of ['/assets/missing-smoke-asset.js', '/landing-smoke-unknown-route']) {
  assert.equal((await request(path)).status, 404, 'Unknown landing paths must return 404');
}
console.log('Landing smoke OK: static content, assets, health and true 404s');
