import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { planMigration, applyMigration } from '../src/migration.js';

const args = process.argv.slice(2);
const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const projectId = value('--project'), workspace = value('--workspace');
const apply = args.includes('--apply');
if (!projectId || !workspace || (apply && (!value('--plan') || !args.includes('--ack-backup') || value('--confirm-project') !== projectId)) || (apply && args.includes('--dry-run'))) {
  throw new Error('Use --project ID --workspace ID [--dry-run --out FILE]. Applying requires --apply --plan FILE --ack-backup --confirm-project ID.');
}
if (process.env.FIRESTORE_EMULATOR_HOST && (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST) || !projectId.startsWith('demo-'))) throw new Error('Emulator migrations require loopback and a demo project.');
const app = initializeApp({ projectId });
try {
  const db = getFirestore(app);
  if (apply) {
    const plan = JSON.parse(await readFile(value('--plan'), 'utf8'));
    if (plan.workspace !== workspace) throw new Error('Plan workspace mismatch.');
    console.log(JSON.stringify(await applyMigration(db, projectId, plan)));
  } else {
    const plan = await planMigration(db, projectId, workspace);
    const out = value('--out') || `.migration-reports/${projectId}-${workspace}.json`;
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ dryRun: true, customers: plan.customers.length, errors: plan.errors.length, plan: out, warning: plan.warning }));
    if (plan.errors.length) process.exitCode = 1;
  }
} finally { await deleteApp(app); }
