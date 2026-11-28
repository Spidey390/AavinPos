import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const requireBuilder = createRequire(import.meta.resolve('app-builder-lib'));
const { listPackage, statFile, extractFile } = requireBuilder('@electron/asar');
const { getCurrentFuseWire, FuseV1Options, FuseState } = requireBuilder('@electron/fuses');
const folder = resolve('releases/win-unpacked');
const archive = resolve(folder, 'resources/app.asar');
const names = listPackage(archive).map(name => name.replace(/^\//, '')).filter(name => statFile(archive, name).files == null);
for (const name of names) {
  assert.match(name, /^(main\.js|preload\.cjs|public-config\.json|package\.json|core\/[A-Za-z]+\.js|ui-build\/index\.html|ui-build\/assets\/[A-Za-z0-9_-]+\.(js|css))$/, `Unexpected packaged file: ${name}`);
  assert.equal(Boolean(statFile(archive, name).unpacked), false);
  const packaged = extractFile(archive, name);
  // Builder normalizes package.json; all runtime code/assets must be identical.
  if (name !== 'package.json') assert.deepEqual(packaged, await readFile(resolve('.desktop-package', name)), `Stale packaged file: ${name}`);
  const text = packaged.toString('utf8');
  assert.doesNotMatch(text, /-----BEGIN [A-Z ]*PRIVATE KEY-----|firebase-admin|applicationDefault\(|gh[pousr]_[A-Za-z0-9]{24,}/, `Unexpected credential/server reference: ${name}`);
}
const config = JSON.parse(extractFile(archive, 'public-config.json'));
assert.deepEqual(Object.keys(config).sort(), ['apiKey', 'projectId']);
const fuses = await getCurrentFuseWire(resolve(folder, 'Aavin POS.exe'));
// FuseState is not exported in some releases; ASCII '0'/'1' is the wire format.
for (const option of ['RunAsNode', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments']) assert.equal(fuses[FuseV1Options[option]], FuseState?.DISABLE ?? 48, `Unsafe fuse: ${option}`);
for (const option of ['OnlyLoadAppFromAsar', 'EnableEmbeddedAsarIntegrityValidation']) assert.equal(fuses[FuseV1Options[option]], FuseState?.ENABLE ?? 49, `Missing fuse: ${option}`);
const installer = resolve('releases/Aavin-POS-1.0.0-Windows-x64-Setup.exe');
const bytes = await readFile(installer);
assert.equal(bytes.subarray(0, 2).toString(), 'MZ');
const digest = createHash('sha256').update(bytes).digest('hex');
await writeFile(installer + '.sha256', `${digest}  Aavin-POS-1.0.0-Windows-x64-Setup.exe\n`);
console.log(`Verified ${names.length} allowlisted app files, matching source, public-only config, hardened Electron fuses and Windows installer checksum.`);
