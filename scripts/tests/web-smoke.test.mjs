import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import test from 'node:test';

const languages = { en: 'Workspace', es: 'Espacio de trabajo', uk: 'Робочий простір', de: 'Arbeitsbereich', pt: 'Área de trabalho' };
const localizedHtml = (locale, heading = languages[locale]) => `<html lang="${locale}"><head><title data-i18n="meta.title">Workspace ${locale}</title><meta name="description" content="Description ${locale}"></head><body><h1>${heading}</h1><a data-app-link="hero" href="https://app.example.test">Open</a><select data-language-picker>${Object.keys(languages).map(code => `<option value="${code}">${code}</option>`).join('')}</select><script src="/assets/app.js"></script></body></html>`;
const html = localizedHtml('en');

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
    } else if (Object.keys(languages).some(locale => request.url === `/${locale}/`)) {
      const locale = request.url.split('/')[1];
      type = 'text/html';
      cache = 'no-cache';
      status = broken === 'locale-missing' && locale === 'es' ? 404 : 200;
      body = broken === 'locale-language' && locale === 'es' ? html : localizedHtml(locale, broken === 'locale-copy' ? languages.en : languages[locale]);
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
  for (const locale of Object.keys(languages)) assert.ok(result.requests.some(request => request.path === `/${locale}/`));
  for (const { headers } of result.requests) {
    assert.equal(headers.host, 'configured.example.test');
    assert.equal(headers.authorization, undefined);
  }
});

for (const broken of ['locale-missing', 'locale-language', 'locale-copy']) {
  test(`landing smoke rejects ${broken} instead of accepting a fallback page`, async () => {
    const result = await runSmoke('landing', { broken });
    assert.notEqual(result.code, 0);
    assert.match(result.output, /Localized landing/);
  });
}

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
