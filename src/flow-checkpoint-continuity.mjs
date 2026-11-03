import { encodeCheckpointRecord } from './flow-checkpoint-record.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameEpoch = (a, b) => a.kind === b.kind && a.anchor === b.anchor;
const normalized = marker => marker === null ? null : { ...marker, phase: 'committed' };

// Checks structural continuity between two already obtained records. Fresh
// native events, comment evidence, Project status, authorization, branch
// provenance and CAS must still be checked separately before any write.
export function verifyCheckpointContinuity(before, after) {
  const encodedAfter = encodeCheckpointRecord(after);
  if (encodedAfter.kind !== 'encoded-record') return blocked('invalid-next-record');
  if (before === null) {
    if (after.epoch.kind === 'initial' && after.current?.phase === 'pending' && after.previous === null) return { kind: 'continuity-verified' };
    if (after.epoch.kind === 'reopened' && after.reentry?.phase === 'pending' && after.current === null
        && after.previous === null && after.reentry.previous === null) return { kind: 'continuity-verified' };
    return blocked('invalid-initial-record');
  }
  if (encodeCheckpointRecord(before).kind !== 'encoded-record') return blocked('invalid-previous-record');
  if (['repositoryId', 'number', 'issueId', 'cutoverAt'].some(key => before[key] !== after[key])) return blocked('record-identity-changed');
  if (!sameEpoch(before.epoch, after.epoch)) {
    if (after.epoch.kind !== 'reopened' || after.reentry?.phase !== 'pending'
        || before.reentry?.phase === 'pending' || before.current?.phase === 'pending'
        || (before.reentry && after.reentry.reopenedAt <= before.reentry.reopenedAt)
        || !same(after.current, before.current) || after.previous !== null
        || !same(after.reentry.previous, before.current)) return blocked('invalid-reentry-transition');
    return { kind: 'continuity-verified' };
  }
  if ((before.reentry === null) !== (after.reentry === null)) return blocked('reentry-changed');
  if (before.reentry) {
    for (const key of ['reopenedAt', 'fromStatus', 'previous']) {
      if (!same(before.reentry[key], after.reentry[key])) return blocked('reentry-evidence-changed');
    }
    if (before.reentry.phase === 'ready' && after.reentry.phase !== 'ready') return blocked('reentry-regressed');
    if (before.reentry.phase === 'pending' && !same(before.current, after.current)) return blocked('reentry-handoff-changed');
  }
  if (same(before.current, after.current) && same(before.previous, after.previous)) return { kind: 'continuity-verified' };
  if (before.reentry?.phase === 'pending' || after.reentry?.phase === 'pending') return blocked('reentry-in-progress');
  if (before.current === null && after.current?.phase === 'pending' && after.previous === null) return { kind: 'continuity-verified' };
  if (before.current?.phase === 'committed' && after.current?.phase === 'pending'
      && same(after.previous, before.current)) return { kind: 'continuity-verified' };
  if (before.current?.phase === 'pending' && after.current?.phase === 'committed' && after.previous === null
      && same(normalized(before.current), after.current)) return { kind: 'continuity-verified' };
  return blocked('invalid-handoff-transition');
}
