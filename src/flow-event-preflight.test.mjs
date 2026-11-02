import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectFlowEvent } from './flow-event-preflight.mjs';

const centralRepository = 'Owner/flow';
const native = action => ({ action, repository: { full_name: 'owner/flow' }, issue: { number: 7 } });
const run = (eventName, event, extra = {}) => inspectFlowEvent({ eventName, event, centralRepository, ...extra });

test('accepts supported native issue events only for the central repository', () => {
  for (const [name, actions] of [['issue_comment', ['created', 'edited', 'deleted']], ['issues', ['opened', 'closed', 'reopened']]]) {
    for (const action of actions) {
      assert.deepEqual(run(name, native(action)), { kind: 'candidate', repository: centralRepository, issueNumber: 7 });
    }
  }
  assert.deepEqual(run('issues', { ...native('opened'), repository: { full_name: 'other/repo' } }), { kind: 'blocked', reason: 'invalid-event' });
  assert.deepEqual(run('issue_comment', { ...native('created'), issue: { number: 7, pull_request: {} } }), { kind: 'ignored' });
});

test('accepts only allowlisted dispatch hints without trusting their contents', () => {
  const source = '0123456789abcdef0123456789abcdef';
  const routes = [{ source, repository: 'Private/Project' }];
  const event = { action: 'flow-wakeup-v1', repository: { full_name: centralRepository }, client_payload: { source, issueNumber: 23 } };
  assert.deepEqual(run('repository_dispatch', event, { routes }),
    { kind: 'candidate', repository: 'Private/Project', issueNumber: 23 });
  assert.deepEqual(run('repository_dispatch', event, { routes: [{ source: 'abcdef0123456789abcdef0123456789', repository: 'other/project' }] }), { kind: 'blocked', reason: 'source-not-allowed' });
  assert.deepEqual(run('repository_dispatch', { ...event, client_payload: { ...event.client_payload, targetStatus: 'done' } },
    { routes }), { kind: 'blocked', reason: 'invalid-wakeup' });
  assert.deepEqual(run('repository_dispatch', { ...event, client_payload: { repository: 'private/project', issueNumber: 23 } },
    { routes }), { kind: 'blocked', reason: 'invalid-wakeup' });
  assert.deepEqual(run('repository_dispatch', event, { routes: [...routes, ...routes] }), { kind: 'blocked', reason: 'invalid-routes' });
  assert.deepEqual(run('repository_dispatch', event, { routes: [...routes, { source: 'abcdef0123456789abcdef0123456789', repository: 'private/project' }] }),
    { kind: 'blocked', reason: 'invalid-allowlist' });
});

test('fails closed on missing configuration, malformed events and unexpected actions', () => {
  assert.deepEqual(run('repository_dispatch', { action: 'flow-wakeup-v1', repository: { full_name: centralRepository }, client_payload: { source: '0123456789abcdef0123456789abcdef', issueNumber: 1 } }),
    { kind: 'blocked', reason: 'invalid-routes' });
  assert.deepEqual(run('issue_comment', null), { kind: 'blocked', reason: 'invalid-event' });
  assert.deepEqual(run('issue_comment', { ...native('created'), issue: { number: '7' } }), { kind: 'blocked', reason: 'invalid-wakeup' });
  assert.deepEqual(run('issues', native('edited')), { kind: 'ignored' });
  assert.deepEqual(run('repository_dispatch', { action: 'other', repository: { full_name: centralRepository } }), { kind: 'ignored' });
});
