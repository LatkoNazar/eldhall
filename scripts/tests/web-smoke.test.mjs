import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import test from 'node:test';

const html = '<h1>Workspace</h1><a data-app-link="hero" href="https://app.example.test">Open</a><script src="/assets/app.js"></script>';

async function runSmoke(script, { broken = '' } = {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ path: request.url, headers: request.headers, method: request.method });
    let status = 200;
    let type = 'text/plain';
    let body = 'ok';
    let cache;
    if (request.url === '/' || request.url === '/workspace/example') {
      type = 'text/html';
      cache = 'no-cache';
      body = broken === 'cta' ? html.replace('data-app-link', 'data-no-link') : html;
    } else if (request.url === '/assets/app.js') {
      type = broken === 'asset' ? 'text/html' : 'application/javascript';
      cache = 'public, max-age=31536000, immutable';
      body = broken === 'asset' ? html : 'console.log("built");';
    } else if (request.url.startsWith('/health/')) {
      type = 'application/json';
      body = JSON.stringify({ status: 'ok' });
    } else if (request.url === '/api/v1/jobs') {
      status = broken === 'auth' ? 200 : 401;
      type = 'application/json';
      body = '{}';
    } else if (!['/frontend-health', '/landing-health'].includes(request.url)) {
      status = broken === '404' ? 200 : 404;
      type = 'application/json';
      body = '{}';
    }
    response.writeHead(status, { 'Content-Type': type, ...(cache ? { 'Cache-Control': cache } : {}) });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const source = await readFile(new URL(`../${script}-smoke.mjs`, import.meta.url));
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-'], {
        cwd: tmpdir(),
        env: {
          ...process.env,
          SMOKE_BASE_URL: `http://127.0.0.1:${server.address().port}`,
          SMOKE_HOST: 'configured.example.test',
          API_TOKEN: 'must-not-be-sent-by-web-smoke',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, output, requests }));
      child.stdin.end(source);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('standalone frontend smoke validates proxy/auth and sends exact Host without a bearer token', async () => {
  const result = await runSmoke('frontend');
  assert.equal(result.code, 0, result.output);
  assert.ok(result.requests.some(({ path, method }) => path === '/api/v1/jobs' && method === 'POST'));
  for (const { headers } of result.requests) {
    assert.equal(headers.host, 'configured.example.test');
    assert.equal(headers.authorization, undefined);
  }
});

test('frontend smoke rejects an HTML asset fallback', async () => {
  const result = await runSmoke('frontend', { broken: 'asset' });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /Asset returned SPA HTML/);
});

test('frontend smoke rejects authentication lost by the proxy', async () => {
  const result = await runSmoke('frontend', { broken: 'auth' });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /API proxy did not preserve authentication/);
});

test('standalone landing smoke validates real HTML/assets/404s without analytics or credentials', async () => {
  const result = await runSmoke('landing');
  assert.equal(result.code, 0, result.output);
  for (const { headers } of result.requests) {
    assert.equal(headers.host, 'configured.example.test');
    assert.equal(headers.authorization, undefined);
  }
});

test('landing smoke rejects a missing static CTA', async () => {
  const result = await runSmoke('landing', { broken: 'cta' });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /Landing app link is missing from HTML/);
});

test('landing smoke rejects successful unknown routes', async () => {
  const result = await runSmoke('landing', { broken: '404' });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /Unknown landing paths must return 404/);
});
