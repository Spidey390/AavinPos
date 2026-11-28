import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolveFirebaseConfig } from '../src/domain/firebaseConfig.js';

const folder = resolve('.desktop-package');
const registration = resolveFirebaseConfig(loadEnv('production', process.cwd(), 'VITE_'), false);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir(folder, { recursive: true });
// Explicit allowlist: no Admin SDK, .env, server code, reports or credentials.
for (const name of ['main.js', 'preload.cjs', 'core']) await cp(resolve('desktop', name), resolve(folder, name), { recursive: true });
await writeFile(resolve(folder, 'public-config.json'), JSON.stringify({ projectId: registration.projectId, apiKey: process.env.DESKTOP_FIREBASE_API_KEY || registration.apiKey }));
await writeFile(resolve(folder, 'package.json'), JSON.stringify({ name: 'aavin-pos-desktop', version: pkg.version, type: 'module', main: 'main.js', description: 'Aavin POS offline cash counter', author: 'Aavin POS', private: true }));
await build({ configFile: false, root: resolve('desktop/ui'), base: './', publicDir: false, plugins: [react()], build: { outDir: resolve(folder, 'ui-build'), emptyOutDir: true, sourcemap: false } });
console.log('Desktop staging built with public Firebase registration only.');
