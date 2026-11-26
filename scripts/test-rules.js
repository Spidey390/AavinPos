// Runs the official emulator directly, without adding the deployment CLI and its
// unrelated dependencies to this application's dependency tree. Java 21+ required.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { open, mkdir, mkdtemp, readFile, writeFile, rename } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const name = 'cloud-firestore-emulator-v1.22.0.jar';
// Published by Firebase Tools in downloadableEmulatorInfo.json for v1.22.0.
const expected = '9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c';
const cache = join(homedir(), '.cache', 'firebase', 'emulators');
const jar = join(cache, name);
let bytes;
try {
  bytes = await readFile(jar);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  console.log('Downloading the official Firestore emulator (one-time, ~130 MB)…');
  const response = await fetch(`https://storage.googleapis.com/firebase-preview-drop/emulator/${name}`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Emulator download failed (${response.status}).`, { cause: error });
  bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Emulator checksum mismatch.', { cause: error });
  await mkdir(cache, { recursive: true });
  const temporary = `${jar}.${process.pid}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx' });
  await rename(temporary, jar);
}
if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Cached emulator checksum mismatch.');

const portServer = createServer();
portServer.listen(0, '127.0.0.1');
await once(portServer, 'listening');
const port = portServer.address().port;
await new Promise((resolve, reject) => portServer.close(error => error ? reject(error) : resolve()));
const logDirectory = await mkdtemp(join(tmpdir(), 'aavin-rules-'));
const log = await open(join(logDirectory, 'emulator.log'), 'w');
const emulator = spawn('java', ['-jar', jar, '--host', '127.0.0.1', '--port', String(port),
  '--project_id', 'demo-pos-rules', '--rules', resolve('firestore.rules'), '--single_project_mode', 'true'],
{ cwd: logDirectory, stdio: ['ignore', log.fd, log.fd] });
let startError;
emulator.on('error', error => { startError = error; });
const stop = () => { emulator.kill('SIGTERM'); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (startError) throw new Error('Java 21+ is required for the Firestore rules tests.', { cause: startError });
    if (emulator.exitCode !== null) throw new Error(`Emulator exited early. See ${logDirectory}/emulator.log`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
      ready = response.ok;
    } catch { /* Wait for the local emulator's HTTP listener. */ }
    if (ready) break;
    await delay(200);
  }
  if (!ready) throw new Error(`Emulator did not start. See ${logDirectory}/emulator.log`);
  const tests = spawn(process.execPath, ['--test', 'tests/firestore.rules.test.js'], {
    stdio: 'inherit', env: { ...process.env, FIRESTORE_EMULATOR_HOST: `127.0.0.1:${port}` }
  });
  const [code] = await once(tests, 'exit');
  process.exitCode = code ?? 1;
} finally {
  const exited = once(emulator, 'exit');
  stop();
  const forcedStop = setTimeout(() => emulator.kill('SIGKILL'), 5000);
  forcedStop.unref();
  if (emulator.exitCode === null && !startError) await exited;
  clearTimeout(forcedStop);
  await log.close();
}
