import { randomBytes } from 'node:crypto';

const oid = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) && value !== '0'.repeat(40);
const zero = '0'.repeat(40);
const equal = (pair, value) => Array.isArray(pair) && pair.length === 2 && pair[0] === value && pair[1] === value;
const failed = (reason, suffix, refsMayRemain = false) => ({ kind: 'blocked', reason, ...(refsMayRemain ? { suffix } : {}) });

// Only the injected, trusted transport can reach GitHub. The two refs are
// freshly named, bound to one private repository and never point to product
// branch names. No API error text or private repository metadata is returned.
export async function runAtomicRefProbe(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !input.transport
      || !['initial', 'refs', 'update'].every(key => typeof input.transport[key] === 'function')) return failed('invalid-input');
  const suffix = input.suffix ?? randomBytes(10).toString('hex');
  if (typeof suffix !== 'string' || !/^[a-f0-9]{20}$/.test(suffix)) return failed('invalid-input');
  const names = [`refs/heads/probe/agf-atomic-${suffix}/a`, `refs/heads/probe/agf-atomic-${suffix}/b`];
  const { transport } = input;
  let initial;
  try { initial = await transport.initial(); } catch { return failed('initial-read-failed'); }
  if (!initial || typeof initial.repositoryId !== 'string' || !initial.repositoryId || initial.private !== true
      || initial.scopeVerified !== true || initial.appVerified !== true || initial.defaultBranch !== 'main'
      || !oid(initial.oldOid) || !oid(initial.newOid) || initial.oldOid === initial.newOid) return failed('invalid-initial-state');
  const { repositoryId, oldOid, newOid } = initial;
  const read = async () => transport.refs({ repositoryId, names: [...names] });
  const update = async (beforeA, afterA, beforeB, afterB) => transport.update({ repositoryId, refUpdates: [
    { name: names[0], beforeOid: beforeA, afterOid: afterA, force: false },
    { name: names[1], beforeOid: beforeB, afterOid: afterB, force: false },
  ] });
  try {
    if (!equal(await read(), null)) return failed('ref-already-exists');
    const create = await update(zero, oldOid, zero, oldOid);
    if (create?.kind !== 'ok') return failed('create-unconfirmed', suffix, true);
    if (!equal(await read(), oldOid)) return failed('create-readback-mismatch', suffix, true);
    const advance = await update(oldOid, newOid, oldOid, newOid);
    if (advance?.kind !== 'ok') return failed('advance-unconfirmed', suffix, true);
    if (!equal(await read(), newOid)) return failed('advance-readback-mismatch', suffix, true);
    const negative = await update(newOid, zero, oldOid, zero);
    if (negative?.kind !== 'rejected') return failed('negative-unconfirmed', suffix, true);
    if (!equal(await read(), newOid)) return failed('negative-readback-mismatch', suffix, true);
    const cleanup = await update(newOid, zero, newOid, zero);
    if (cleanup?.kind !== 'ok' || !equal(await read(), null)) return failed('cleanup-unconfirmed', suffix, true);
    return { kind: 'complete', positive: 'confirmed', negative: negative.staleConfirmed === true ? 'confirmed' : 'unverified' };
  } catch { return failed('transport-unconfirmed', suffix, true); }
}
