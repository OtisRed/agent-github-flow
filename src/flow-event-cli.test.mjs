import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('diagnostic never echoes private event content or configured repositories', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agf-event-')); const file = join(dir, 'event.json');
  try {
    const privateRepo = 'Private/secret-project'; const secretText = 'private-comment-content'; const source = '0123456789abcdef0123456789abcdef';
    writeFileSync(file, JSON.stringify({ action: 'flow-wakeup-v1', repository: { full_name: 'Owner/flow' },
      client_payload: { source, issueNumber: 23 }, comment: { body: secretText } }));
    const script = fileURLToPath(new URL('./flow-event-cli.mjs', import.meta.url));
    const env = { ...process.env, GITHUB_EVENT_PATH: file, GITHUB_EVENT_NAME: 'repository_dispatch',
      GITHUB_REPOSITORY: 'Owner/flow', FLOW_EVENT_ROUTES: JSON.stringify([{ source, repository: privateRepo }]) };
    let result = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
    assert.equal(result.status, 0); assert.match(result.stdout, /candidate; no writes performed/);
    assert.doesNotMatch(result.stdout + result.stderr, /secret-project|private-comment-content|23/);
    result = spawnSync(process.execPath, [script], { env: { ...env, FLOW_EVENT_ROUTES: '{invalid' }, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /blocked/);
    assert.doesNotMatch(result.stdout + result.stderr, /secret-project|private-comment-content|23/);
  } finally { unlinkSync(file); rmdirSync(dir); }
});

test('independent route is used without logging it and invalid configuration remains blocked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agf-event-route-')); const file = join(dir, 'event.json');
  try {
    const source = '0123456789abcdef0123456789abcdef';
    const privateRepo = 'Private/route-project';
    writeFileSync(file, JSON.stringify({ action: 'flow-wakeup-v1', repository: { full_name: 'Owner/flow' },
      client_payload: { source, issueNumber: 23 } }));
    const script = fileURLToPath(new URL('./flow-event-cli.mjs', import.meta.url));
    const env = { ...process.env, GITHUB_EVENT_PATH: file, GITHUB_EVENT_NAME: 'repository_dispatch',
      GITHUB_REPOSITORY: 'Owner/flow', FLOW_EVENT_ROUTES: '[]', FLOW_EVENT_SELECTED_REPOSITORY: privateRepo };
    const invoke = extra => spawnSync(process.execPath, [script], { env: { ...env, ...extra }, encoding: 'utf8' });
    const accepted = invoke({});
    assert.equal(accepted.status, 0); assert.match(accepted.stdout, /candidate; no writes performed/);
    assert.doesNotMatch(accepted.stdout + accepted.stderr, /route-project|0123456789abcdef|23/);
    for (const extra of [
      { FLOW_EVENT_SELECTED_REPOSITORY: '' },
      { FLOW_EVENT_SELECTED_REPOSITORY: 'invalid repository' },
      { FLOW_EVENT_ROUTES: '{invalid' },
      { FLOW_EVENT_ROUTES: '' },
      { FLOW_EVENT_ROUTES: JSON.stringify([{ source, repository: 'Owner/legacy' }]) },
    ]) {
      const result = invoke(extra);
      assert.equal(result.status, 1); assert.equal(result.stderr.trim(), 'Event preflight: blocked');
      assert.doesNotMatch(result.stdout + result.stderr, /route-project|0123456789abcdef|23/);
    }
  } finally { unlinkSync(file); rmdirSync(dir); }
});
