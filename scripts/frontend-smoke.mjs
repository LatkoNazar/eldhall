// Standalone: also executes through `node --input-type=module -` inside the API image.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';

const base = (process.env.SMOKE_BASE_URL || 'http://frontend:8080').replace(/\/$/, '');
const host = process.env.SMOKE_HOST || 'localhost';

function request(path, { method = 'GET', body } = {}) {
  const url = new URL(base + path);
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const headers = { Host: host };
    if (body) headers['Content-Type'] = 'application/json';
    const req = transport.request(url, { method, headers }, (response) => {
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
    req.end(body);
  });
}

function ok(response, label) {
  assert.equal(response.status, 200, `${label}: expected HTTP 200`);
  return response;
}

const index = ok(await request('/'), 'Frontend index');
assert.match(index.headers['content-type'] || '', /text\/html/, 'Frontend index is not HTML');
assert.match(index.headers['cache-control'] || '', /no-cache/, 'Frontend index must revalidate');
assert.deepEqual(ok(await request('/workspace/example'), 'SPA deep link').body, index.body,
  'SPA deep link did not receive the index');
const assets = [...new Set([...index.body.toString().matchAll(
  /\b(?:src|href)\s*=\s*["'](\/assets\/[^"']+)["']/g,
)].map((match) => match[1]))];
assert.ok(assets.length, 'Frontend index contains no built assets');
for (const path of assets) {
  const asset = ok(await request(path), 'Built asset');
  assert.ok(asset.body.length, 'Built asset is empty');
  assert.doesNotMatch(asset.headers['content-type'] || '', /text\/html/, 'Asset returned SPA HTML');
  assert.match(asset.headers['cache-control'] || '', /immutable/, 'Built asset must be immutable');
}
assert.equal((await request('/assets/missing-smoke-asset.js')).status, 404, 'Missing asset must return 404');
ok(await request('/frontend-health'), 'Frontend health');
for (const path of ['/health/live', '/health/ready']) {
  const health = ok(await request(path), 'Backend health proxy');
  assert.equal(JSON.parse(health.body).status, 'ok', 'Backend health proxy failed');
}
const missing = await request('/api/v1/frontend-smoke-missing');
assert.equal(missing.status, 404, 'Unknown API route must remain 404');
assert.match(missing.headers['content-type'] || '', /application\/json/, 'Unknown API route returned SPA HTML');
JSON.parse(missing.body);
assert.equal((await request('/api/v1/jobs', {
  method: 'POST', body: JSON.stringify({ text: 'smoke', operation: 'uppercase' }),
})).status, 401, 'API proxy did not preserve authentication');
console.log('Frontend smoke OK: SPA, assets, health proxy and authentication');
