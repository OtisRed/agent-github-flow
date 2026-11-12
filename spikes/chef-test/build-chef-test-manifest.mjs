import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// Run once immediately after extracting the commit, before making source changes.
const commit = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('Expected the full 40-character Git commit.');
const files = {};
function add(path) {
  for (const entry of readdirSync(path, {withFileTypes:true})) {
    const name = join(path, entry.name);
    if (entry.isDirectory()) add(name);
    else if (entry.isFile()) files[name.replaceAll('\\','/')] = createHash('sha256').update(readFileSync(name)).digest('hex');
  }
}
for (const dir of ['src', 'test-support']) add(dir);
for (const file of ['package.json', 'package-lock.json']) files[file] = createHash('sha256').update(readFileSync(file)).digest('hex');
writeFileSync('chef-test-source.json', JSON.stringify({commit, files}, null, 2) + '\n', {flag:'wx'});
