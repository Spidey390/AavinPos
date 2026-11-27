import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { applicationDefault } from 'firebase-admin/app';
import { collectSnapshot, verifySnapshot } from '../src/backup.js';
const args = process.argv.slice(2), value = key => args.includes(key) ? args[args.indexOf(key)+1] : undefined, projectId = value('--project');
if (!projectId || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) throw new Error('Specify --project ID and --verify FILE, or --out FILE --ack-maintenance.');
if (value('--verify')) console.log(JSON.stringify({ verified: true, ...verifySnapshot(JSON.parse(await readFile(value('--verify'),'utf8')), projectId) }));
else {
  if (!value('--out') || !args.includes('--ack-maintenance')) throw new Error('Stop all writers, wait 30 seconds, then specify --out FILE --ack-maintenance.');
  if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Backup CLI must not mix emulator and real project settings.');
  const credential = applicationDefault(), started = Date.now(); let token;
  const request = async (path, method, body) => {
    if (Date.now()-started > 45*60000) throw new Error('Backup exceeded the snapshot time window.');
    if (!token || token.expiry < Date.now()+60000) { const next = await credential.getAccessToken(); token = { value: next.access_token, expiry: Date.now()+next.expires_in*1000 }; }
    const response = await fetch(`https://firestore.googleapis.com/v1/${path}`, { method, headers: { Authorization: `Bearer ${token.value}`, ...(body ? { 'Content-Type':'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Firestore backup read failed (HTTP ${response.status}). Check credentials, project and quotas.`);
    return response;
  };
  const clock = await request(`projects/${projectId}/databases/(default)/documents:listCollectionIds`, 'POST', { pageSize: 1 });
  const serverTime = Date.parse(clock.headers.get('Date'));
  if (!Number.isFinite(serverTime)) throw new Error('Cannot establish the Firestore snapshot time.');
  const snapshot = await collectSnapshot({ projectId, readTime: new Date(serverTime-10000).toISOString(), request: async (...params) => (await request(...params)).json() });
  const verified = verifySnapshot(snapshot, projectId);
  await mkdir(dirname(value('--out')), { recursive: true, mode: 0o700 });
  await writeFile(value('--out'), JSON.stringify(snapshot)+'\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ backupWritten: true, ...verified, file: value('--out') }));
}
