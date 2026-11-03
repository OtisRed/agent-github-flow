import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('runtime modules in src do not reference test-only legacy writers', async () => {
  const sourceRoot = fileURLToPath(new URL('.', import.meta.url));
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await inspect(path);
      else if (entry.isFile() && entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) {
        const source = await readFile(path, 'utf8');
        assert.doesNotMatch(source, /test-support|legacy-flow-github-write|flow-github-write\.mjs/, path);
      }
    }
  }
  await inspect(sourceRoot);
});
