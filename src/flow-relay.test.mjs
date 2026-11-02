import test from 'node:test';
import assert from 'node:assert/strict';
import { relayFlowEvent } from './flow-relay.mjs';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = '0123456789abcdef0123456789abcdef';
const base = { eventName: 'issue_comment', event: { action: 'created', issue: { number: 42 }, comment: { body: 'private' } },
  source, targetRepository: 'owner/flow', token: 'dummy-token' };

test('sends only the minimal wakeup to the fixed GitHub API, never the private event', async () => {
  let call;
  const result = await relayFlowEvent({ ...base, fetchFn: async (...args) => { call = args; return { status: 204 }; } });
  assert.deepEqual(result, { kind: 'sent' });
  assert.equal(call[0], 'https://api.github.com/repos/owner/flow/dispatches');
  assert.equal(call[1].redirect, 'error');
  assert.deepEqual(JSON.parse(call[1].body), { event_type: 'flow-wakeup-v1', client_payload: { source, issueNumber: 42 } });
  assert.doesNotMatch(call[1].body, /private|dummy-token/);
});

test('ignores unsupported events and pull requests; blocks bad configuration before any request', async () => {
  let calls = 0; const fetchFn = async () => { calls++; return { status: 204 }; };
  for (const changed of [{ eventName: 'push' }, { event: { action: 'edited', issue: { number: 42, pull_request: {} } } }])
    assert.deepEqual(await relayFlowEvent({ ...base, ...changed, fetchFn }), { kind: 'ignored' });
  for (const changed of [{ source: 'private/project' }, { token: '' }, { token: 'x\r\ny' }, { targetRepository: '../evil' }, { targetRepository: 'x/..' }, { event: { action: 'created', issue: { number: -1 } } }])
    assert.deepEqual(await relayFlowEvent({ ...base, ...changed, fetchFn }), { kind: 'blocked' });
  assert.equal(calls, 0);
});

test('never retries or exposes response data on uncertain outcome', async () => {
  let calls = 0;
  for (const fetchFn of [async () => { calls++; return { status: 403, body: 'private' }; }, async () => { calls++; throw Error('dummy-token private'); }])
    assert.deepEqual(await relayFlowEvent({ ...base, fetchFn }), { kind: 'uncertain' });
  assert.equal(calls, 2);
});

test('CLI does not expose credentials, issue number, or private event on errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agf-relay-'));
  const eventFile = join(dir, 'event.json'); const mockFile = join(dir, 'mock.mjs');
  try {
    writeFileSync(eventFile, JSON.stringify(base.event));
    writeFileSync(mockFile, "globalThis.fetch = async () => { throw Error('dummy-token private 42'); };\n");
    const script = fileURLToPath(new URL('./flow-relay-cli.mjs', import.meta.url));
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(mockFile).href, script], { encoding: 'utf8', env: {
      ...process.env, GITHUB_EVENT_PATH: eventFile, GITHUB_EVENT_NAME: base.eventName,
      FLOW_RELAY_SOURCE: base.source, FLOW_RELAY_TARGET: base.targetRepository, FLOW_RELAY_TOKEN: base.token,
    } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /blocked or uncertain/);
    assert.doesNotMatch(result.stdout + result.stderr, /dummy-token|private|42|owner\/flow/);
  } finally { unlinkSync(eventFile); unlinkSync(mockFile); rmdirSync(dir); }
});
