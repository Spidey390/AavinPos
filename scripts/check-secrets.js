// Heuristic local scan; never prints a matched credential. Public Firebase web
// registration is intentionally allowed. Review provider-side key restrictions.
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const patterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['credential-bearing database URI', /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql):\/\/[^\s'"/]+:[^\s'"@]+@/g],
  ['AWS access key', /(?:AKIA|ASIA)[A-Z0-9]{16}/g],
  ['OpenAI secret key', /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}/g],
  ['payment secret key', /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{24,}/g],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{24,}/g],
  ['JWT', /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g],
  ['literal private credential', /(?<![\w$])(?:password|jwt[_-]?secret|client[_-]?secret|private[_-]?key|api[_-]?secret)['"]?\s*[:=]\s*['"][A-Za-z0-9_+/-]{12,}['"]/gi]
];
const findings = new Set();
function scan(label, bytes) {
  if (bytes.includes(0)) return;
  const text = bytes.toString('utf8');
  for (const [kind, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) findings.add(`${label}:${text.slice(0, match.index).split('\n').length}: ${kind} (redacted)`);
  }
}
let files = 0;
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.firebase', '.DS_Store'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) { files++; scan(relative(process.cwd(), path), await readFile(path)); }
  }
}
await walk(process.cwd());
const revisions = execFileSync('git', ['rev-list', '--all'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
for (const revision of revisions) {
  const names = execFileSync('git', ['ls-tree', '-rz', '--name-only', revision]).toString().split('\0').filter(Boolean);
  for (const name of names) scan(`${revision.slice(0, 7)}:${name}`, execFileSync('git', ['show', `${revision}:${name}`], { maxBuffer: 20 * 1024 * 1024 }));
}
if (findings.size) {
  for (const finding of findings) console.error(finding);
  process.exitCode = 1;
} else console.log(`No private credentials detected in ${files} working-tree files (including .env/build outputs) or ${revisions.length} available commits. Firebase public web configuration is allowed.`);
