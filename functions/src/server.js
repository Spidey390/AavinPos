import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { initializeApp, applicationDefault, cert, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createCallableHandlers } from './callables.js';
import { createHttpApp } from './http-app.js';
import { serverConfig, validateBuild, validateHostedCredential } from './server-config.js';
export async function startStandalone(env = process.env) {
  const config = serverConfig(env), distPath = fileURLToPath(new URL('../../dist/', import.meta.url));
  validateBuild(config, JSON.parse(await readFile(resolve(distPath, 'build-info.json'), 'utf8')));
  await access(resolve(distPath, 'index.html')); await access(resolve(distPath, '404.html'));
  let credential;
  if (config.hosted) { const value = JSON.parse(await readFile(config.credentialFile, 'utf8')); validateHostedCredential(config, value); credential = cert(value); }
  else credential = applicationDefault();
  const firebase = initializeApp({ projectId: config.projectId, credential });
  const handlers = createCallableHandlers(getFirestore(firebase), { allowRefunds: config.allowRefunds, cors: config.origins });
  const server = createHttpApp({ handlers, origins: config.origins, distPath }).listen(config.port, config.host);
  server.headersTimeout = 15000; server.requestTimeout = 65000;
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  console.log(`pos-server-ready port=${config.port}`);
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; const deadline = setTimeout(() => process.exit(1), 15000); deadline.unref(); server.close(async () => { await deleteApp(firebase); clearTimeout(deadline); }); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await startStandalone(); } catch { console.error('pos-server-start-failed: check project, secret file and production build configuration.'); process.exitCode = 1; }
}
