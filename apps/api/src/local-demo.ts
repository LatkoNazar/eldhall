import { createLocalDemoApp, localDemoAddress } from './local-demo-app.js';

async function main() {
  if (process.argv.length !== 2) throw new Error('Local demo does not accept arguments');
  const app = await createLocalDemoApp();
  let stopping = false;
  const stop = async () => { if (!stopping) { stopping = true; await app.close(); } };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  try {
    // Fastify adds callback fields to its listen options; keep the policy immutable.
    await app.listen({ ...localDemoAddress });
    console.log('Local demo API: http://127.0.0.1:8000 (memory, deterministic rules, synthetic data only)');
  } catch (error) { await stop(); throw error; }
}

main().catch(() => { console.error('Local demo could not start; port 8000 must be free and arguments are not accepted.'); process.exitCode = 1; });
