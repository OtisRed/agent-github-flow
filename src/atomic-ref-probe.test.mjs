import test from 'node:test';
import assert from 'node:assert/strict';
import { runAtomicRefProbe } from './atomic-ref-probe.mjs';

const suffix = 'ab'.repeat(10); const zero = '0'.repeat(40); const oldOid = 'a'.repeat(40); const newOid = 'b'.repeat(40);
const fixture = () => {
  const state = [null, null]; const calls = [];
  const transport = {
    initial: async () => ({ repositoryId: 'repo-id', private: true, scopeVerified: true, appVerified: true,
      defaultBranch: 'main', oldOid, newOid }),
    refs: async () => [...state],
    update: async ({ refUpdates }) => {
      calls.push(structuredClone(refUpdates));
      const expected = refUpdates.map(r => r.beforeOid === zero ? null : r.beforeOid);
      if (expected.some((oid, i) => oid !== state[i])) return { kind: 'rejected', staleConfirmed: true };
      for (let i = 0; i < 2; i += 1) state[i] = refUpdates[i].afterOid === zero ? null : refUpdates[i].afterOid;
      return { kind: 'ok' };
    },
  };
  return { state, calls, transport };
};

test('verifies both updates, rejects stale CAS without partial delete, then cleans its own refs', async () => {
  const f = fixture(); const result = await runAtomicRefProbe({ transport: f.transport, suffix });
  assert.deepEqual(result, { kind: 'complete', positive: 'confirmed', negative: 'confirmed' });
  assert.deepEqual(f.state, [null, null]); assert.equal(f.calls.length, 4);
  for (const update of f.calls) for (const ref of update) {
    assert.match(ref.name, new RegExp(`^refs/heads/probe/agf-atomic-${suffix}/[ab]$`));
    assert.equal(ref.force, false);
  }
});

test('reports an unclassified server rejection without claiming stale CAS', async () => {
  const f = fixture(); const original = f.transport.update;
  f.transport.update = async value => { const result = await original(value);
    return result.kind === 'rejected' ? { kind: 'rejected', staleConfirmed: false } : result; };
  assert.deepEqual(await runAtomicRefProbe({ transport: f.transport, suffix }),
    { kind: 'complete', positive: 'confirmed', negative: 'unverified' });
  assert.deepEqual(f.state, [null, null]);
});

test('does not retry or clean after an uncertain create or advance response', async () => {
  let f = fixture(); f.transport.update = async value => { f.calls.push(value.refUpdates); return { kind: 'unknown' }; };
  let result = await runAtomicRefProbe({ transport: f.transport, suffix });
  assert.deepEqual(result, { kind: 'blocked', reason: 'create-unconfirmed', suffix }); assert.equal(f.calls.length, 1);
  f = fixture(); const original = f.transport.update; let count = 0;
  f.transport.update = async value => { count += 1; return count === 2 ? { kind: 'unknown' } : original(value); };
  result = await runAtomicRefProbe({ transport: f.transport, suffix });
  assert.equal(result.reason, 'advance-unconfirmed'); assert.equal(count, 2); assert.deepEqual(f.state, [oldOid, oldOid]);
});

test('stops on unexpected partial or unknown negative state without blind cleanup', async () => {
  const f = fixture(); const original = f.transport.update; let count = 0;
  f.transport.update = async value => { count += 1; if (count === 3) { f.state[0] = null; return { kind: 'rejected' }; } return original(value); };
  const result = await runAtomicRefProbe({ transport: f.transport, suffix });
  assert.equal(result.reason, 'negative-readback-mismatch'); assert.equal(count, 3);
});

test('rejects unsafe targets and unexpected initial names before any mutation', async () => {
  let f = fixture(); const original = f.transport.initial;
  f.transport.initial = async () => ({ ...(await original()), private: false });
  assert.equal((await runAtomicRefProbe({ transport: f.transport, suffix })).reason, 'invalid-initial-state'); assert.equal(f.calls.length, 0);
  f = fixture(); assert.equal((await runAtomicRefProbe({ transport: f.transport, suffix: '../../main' })).reason, 'invalid-input');
  assert.equal(f.calls.length, 0);
});
