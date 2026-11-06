import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createLocalDemoApp, localDemoAddress } from '../src/local-demo-app.js';

const operator = { authorization: 'Bearer 1111' };

test('local demo genuinely serves memory/rules fixtures, simulated approval and inline starter jobs', async () => {
  const app = await createLocalDemoApp();
  try {
    const ready = await app.inject({ url: '/health/ready' });
    assert.deepEqual(ready.json(), { status: 'ok', dependencies: { memory: 'ok' } });
    assert.equal((await app.inject({ url: '/api/v1/operator/session', headers: operator })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/v1/operator/session', headers: { authorization: 'Bearer not-the-demo-key' } })).statusCode, 401);
    const capabilities = (await app.inject({ url: '/api/v1/capabilities', headers: operator })).json();
    assert.equal(capabilities.runtime, 'rules'); assert.equal(capabilities.provider, 'rules'); assert.equal(capabilities.execution, 'inline');
    assert.equal(capabilities.persistence, 'memory'); assert.equal(capabilities.paymentProvider, 'simulated');
    const personas = (await app.inject({ url: '/api/v1/chat/personas' })).json();
    assert.equal(personas.length, 3);
    assert.equal((await app.inject({url:'/api/v1/workspace',headers:operator})).json().business.id,'00000000-0000-4000-8000-000000000001');
    assert.equal((await app.inject({method:'POST',url:'/api/v1/demo/reset',headers:operator})).statusCode,409);
    const customer = { 'x-customer-session': 'demo-olena' };
    const opened = await app.inject({ method: 'POST', url: '/api/v1/chat/cases', headers: customer });
    assert.equal(opened.statusCode, 201); const id = opened.json().id;
    const turn = await app.inject({ method: 'POST', url: `/api/v1/chat/cases/${id}/messages`, headers: customer, payload: { body: 'You charged me twice for October' } });
    assert.equal(turn.statusCode, 200); assert.ok(turn.json().reply);
    const detail = (await app.inject({ url: `/api/v1/cases/${id}`, headers: operator })).json();
    assert.equal(detail.runs[0].provider, 'rules'); assert.equal(detail.refunds.length, 0);
    const proposal = detail.proposals[0]; assert.equal(proposal.tool, 'refund_payment'); assert.equal(proposal.status, 'pending');
    const approved = await app.inject({ method: 'POST', url: `/api/v1/proposals/${proposal.id}/approve`, headers: operator, payload: { argsHash: proposal.argsHash } });
    assert.equal(approved.statusCode, 200);
    const executed = await app.inject({ method: 'POST', url: `/api/v1/proposals/${proposal.id}/execute`, headers: operator, payload: { argsHash: proposal.argsHash } });
    assert.equal(executed.statusCode, 200); assert.equal(executed.json().proposal.status, 'executed');
    const completed = (await app.inject({ url: `/api/v1/cases/${id}`, headers: operator })).json();
    assert.equal(completed.refunds[0].simulated, true); assert.match(completed.refunds[0].providerRef, /^SIM-RF-/);
    const job = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers: operator, payload: { text: 'local demo', operation: 'uppercase' } });
    assert.equal(job.statusCode, 202);
    const result = (await app.inject({ url: '/api/v1/jobs/' + job.json().id, headers: operator })).json();
    assert.equal(result.status, 'succeeded'); assert.equal(result.result, 'LOCAL DEMO');
    const blocked = await app.inject({ method: 'POST', url: '/api/v1/knowledge/import-url?businessId=00000000-0000-4000-8000-000000000001', headers: operator, payload: { url: 'https://synthetic-private.invalid/data', category: 'Test' } });
    assert.equal(blocked.statusCode, 403);
    assert.equal((await app.inject({ url: '/api/v1/operator/session', headers: { ...operator, host: 'remote.example.invalid' } })).statusCode, 400);
  } finally { await app.close(); }
  const restarted = await createLocalDemoApp();
  try { assert.deepEqual((await restarted.inject({ url: '/api/v1/cases', headers: operator })).json(), []); }
  finally { await restarted.close(); }
});

test('local demo socket is loopback and launcher refuses host/key/port overrides', async () => {
  assert.deepEqual(localDemoAddress, { host: '127.0.0.1', port: 8000 });
  const app = await createLocalDemoApp();
  try {
    await app.listen({ host: localDemoAddress.host, port: 0 });
    const address = app.server.address(); assert.ok(address && typeof address === 'object'); assert.equal(address.address, '127.0.0.1');
    const status = await new Promise<number | undefined>((resolve, reject) => { const request = get({ hostname: address.address, port: address.port, path: '/api/v1/operator/session', headers: operator }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); });
    assert.equal(status, 200);
  } finally { await app.close(); }
  const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/local-demo.ts', import.meta.url)), '--host', '0.0.0.0', '--key', 'synthetic-override', '--port', '9000'], { encoding: 'utf8', timeout: 15_000, env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '' } });
  assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.doesNotMatch(result.stderr, /synthetic-override|0\.0\.0\.0/);
});

test('hostile ambient production settings and synthetic .env cannot redirect the demo to services', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eldhall-local-demo-'));
  const dotenv = join(directory, '.env');
  await writeFile(dotenv, 'ENVIRONMENT=production\nDATABASE_URL=invalid-dotenv-target\nOPERATOR_TOKEN=invalid-dotenv-key\n', { flag: 'wx' });
  try {
    const moduleUrl = new URL('../src/local-demo-app.ts', import.meta.url).href;
    const program = `import assert from 'node:assert/strict';globalThis.fetch=()=>{throw Error('Outbound calls forbidden')};const{createLocalDemoApp}=await import(${JSON.stringify(moduleUrl)});const app=await createLocalDemoApp();try{const headers={authorization:'Bearer 1111'};assert.equal((await app.inject({url:'/api/v1/operator/session',headers})).statusCode,200);const c=(await app.inject({url:'/api/v1/capabilities',headers})).json();assert.equal(c.runtime,'rules');assert.equal(c.persistence,'memory');const customer={'x-customer-session':'demo-olena'};const id=(await app.inject({method:'POST',url:'/api/v1/chat/cases',headers:customer})).json().id;assert.equal((await app.inject({method:'POST',url:'/api/v1/chat/cases/'+id+'/messages',headers:customer,payload:{body:'Hello'}})).statusCode,200);console.log('isolated-local-demo-ok')}finally{await app.close()}`;
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', program], { cwd: directory, encoding: 'utf8', timeout: 15_000, env: {
      PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', ENVIRONMENT: 'production', DATABASE_URL: 'invalid-ambient-target', POSTGRES_HOST: 'remote.invalid', REDIS_HOST: 'remote.invalid', OPERATOR_TOKEN: 'synthetic-private-other-key', SUPPORT_STORE: 'postgres', SUPPORT_EXECUTION: 'worker', SUPPORT_CONFIG_FILE: 'missing-private-config.json', AGENT_RUNTIME: 'dsh', LLM_PROVIDER: 'google', GEMINI_API_KEY: 'synthetic-private-provider-key', OPENROUTER_API_KEY: 'synthetic-private-classifier-key', KB_EMBEDDINGS_PROVIDER: 'openai', OPENAI_API_KEY: 'synthetic-private-embedding-key',
    } });
    assert.equal(result.status, 0, 'Fixed demo must ignore hostile application settings and .env');
    assert.equal(result.stdout.trim(), 'isolated-local-demo-ok'); assert.equal(result.stderr, '');
  } finally { await unlink(dotenv); await rmdir(directory); }
});
