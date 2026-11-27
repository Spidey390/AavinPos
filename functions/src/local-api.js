import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { initializeApp, getApps, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createCallableHandlers } from './callables.js';
import { createHttpApp } from './http-app.js';
import { validateBuild } from './server-config.js';

export async function createLocalApi({ projectId, origins, root, distPath = resolve(root, 'dist'), preview }, env = process.env) {
  if (!projectId || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) || projectId.startsWith('demo-')) throw new Error('Configure a valid Firebase project; use emulators for demo projects.');
  if (env.FIRESTORE_EMULATOR_HOST || env.FIREBASE_AUTH_EMULATOR_HOST || env.FUNCTIONS_EMULATOR === 'true') throw new Error('The live local API must not use emulator credentials or database endpoints.');
  if (env.POS_PROJECT_ID && env.POS_PROJECT_ID !== projectId) throw new Error('Browser and backend projects must match.');
  if (preview) validateBuild({ projectId }, JSON.parse(await readFile(resolve(distPath, 'build-info.json'), 'utf8')));
  let app = getApps().find(app => app.name === '[DEFAULT]');
  if (app && app.options.projectId !== projectId) throw new Error('Restart the dev server after changing Firebase projects.');
  app ??= initializeApp({ projectId, credential: applicationDefault() });
  const handlers = createCallableHandlers(getFirestore(app), { cors: origins, allowRefunds: env.ENABLE_RECONCILED_REFUNDS === 'true' });
  return createHttpApp({ handlers, origins, distPath: resolve(root, 'public') });
}
