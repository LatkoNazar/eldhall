import { setTimeout as delay } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

async function request(path, body) {
  const token = process.env.API_TOKEN ?? '';
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (process.env.SMOKE_HOST) headers.Host = process.env.SMOKE_HOST;
  const url = new URL(`${process.env.SMOKE_BASE_URL ?? 'http://localhost:8000'}${path}`);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = send(url, { method: body ? 'POST' : 'GET', headers, signal: AbortSignal.timeout(10000) }, response => {
      let content = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { content += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        if (!response.statusCode || response.statusCode >= 400) { reject(new Error(`Smoke request failed with HTTP ${response.statusCode}`)); return; }
        try { resolve(JSON.parse(content)); } catch { reject(new Error('Smoke response was not JSON')); }
      });
    });
    request.on('error', reject);
    request.end(body ? JSON.stringify(body) : undefined);
  });
}

async function main() {
  const ready = await request('/health/ready');
  for (const name of ['postgres', 'redis']) {
    if (ready.dependencies[name] !== 'ok') throw new Error(`Dependency ${name} is unavailable`);
  }
  for (const [operation, text, expected] of [
    ['uppercase', 'competition-ready', 'COMPETITION-READY'],
    ['reverse', 'привіт 🌍', '🌍 тівирп'],
  ]) {
    const job = await request('/api/v1/jobs', { text, operation });
    const deadline = Date.now() + 60000;
    let result;
    while (Date.now() < deadline) {
      result = await request(`/api/v1/jobs/${job.id}`);
      if (result.status === 'failed') throw new Error('Background job failed');
      if (result.status === 'succeeded') break;
      await delay(250);
    }
    if (result?.status !== 'succeeded' || result.result !== expected) throw new Error('Unexpected background job result');
  }
  console.log('Smoke OK: API, PostgreSQL, BullMQ worker and Redis readiness');
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Smoke failed'); process.exitCode = 1; });
