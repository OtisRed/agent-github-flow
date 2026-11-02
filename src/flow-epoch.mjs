const blocked = reason => ({ kind: 'blocked', reason });
const timestamp = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value.replace('Z', '.000Z') ? time : null;
};
export const parseFlowTimestamp = timestamp;

// The reader must supply the complete ordered native close/reopen timeline
// and bind handoffCreatedAt to the exact selected GitHub comment. This pure
// function cannot verify pagination, identity or a concurrent state change.
export function verifyHandoffEpoch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return blocked('invalid-input');
  const { complete, issueState, issueCreatedAt, handoffCreatedAt, observedAt, events } = input;
  if (complete !== true) return blocked('incomplete-timeline');
  if (issueState !== 'OPEN' && issueState !== 'CLOSED') return blocked('invalid-issue-state');
  const created = timestamp(issueCreatedAt);
  const handoff = timestamp(handoffCreatedAt);
  const observed = timestamp(observedAt);
  if (created === null || handoff === null || observed === null || handoff < created || observed < handoff) {
    return blocked('invalid-timestamp');
  }
  if (!Array.isArray(events)) return blocked('invalid-timeline');
  let state = 'OPEN';
  let previous = null;
  let lastReopen = null;
  const ids = new Set();
  for (const event of events) {
    if (!event || typeof event !== 'object' || typeof event.id !== 'string' || !event.id || ids.has(event.id)) {
      return blocked('invalid-timeline');
    }
    ids.add(event.id);
    const at = timestamp(event.at);
    if (at === null || at < created || at > observed || (previous !== null && at <= previous)) {
      return blocked('invalid-timeline');
    }
    if (event.type === 'CLOSED' && state === 'OPEN') state = 'CLOSED';
    else if (event.type === 'REOPENED' && state === 'CLOSED') { state = 'OPEN'; lastReopen = at; }
    else return blocked('inconsistent-timeline');
    previous = at;
  }
  if (state !== issueState) return blocked('inconsistent-timeline');
  if (state !== 'OPEN') return blocked('issue-closed');
  if (lastReopen !== null && handoff <= lastReopen) return blocked('handoff-before-or-at-reopen');
  return { kind: 'verified' };
}

// The anchor reuses GitHub's issue ID or the last native reopen event ID; it
// is not an operation ID. The caller must bind the snapshot to that issue.
export function verifyHandoffEpochAndAnchor(input) {
  if (!input || typeof input.issueNodeId !== 'string' || !input.issueNodeId) return blocked('invalid-issue-id');
  const verified = verifyHandoffEpoch(input);
  if (verified.kind !== 'verified') return verified;
  const reopened = [...input.events].reverse().find(event => event.type === 'REOPENED');
  return { kind: 'verified', epoch: reopened
    ? { kind: 'reopened', anchor: reopened.id }
    : { kind: 'initial', anchor: input.issueNodeId } };
}

// Observation time is used only as an upper bound for the native timeline.
export function verifyNativeReopen(input) {
  if (!input || typeof input.issueNodeId !== 'string' || !input.issueNodeId) return blocked('invalid-issue-id');
  const result = verifyHandoffEpochAndAnchor({ ...input, handoffCreatedAt: input.observedAt });
  if (result.kind !== 'verified') return result;
  if (result.epoch.kind !== 'reopened') return blocked('no-reopen-event');
  const reopened = [...input.events].reverse().find(event => event.type === 'REOPENED');
  return { kind: 'native-reopen-evidence', issueNodeId: input.issueNodeId, epoch: result.epoch, reopenedAt: reopened.at };
}

// Classifies the exact checkpointed comment relative to the latest reopen.
// Equal-second ordering is unknowable and therefore never becomes evidence.
export function classifyCheckpointEpoch(input) {
  if (!input || typeof input.issueNodeId !== 'string' || !input.issueNodeId
    || typeof input.commentNodeId !== 'string' || !input.commentNodeId
    || typeof input.commentId !== 'string' || !/^[1-9][0-9]*$/.test(input.commentId)
    || typeof input.commentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.commentDigest)) return blocked('invalid-identity');
  const verdict = verifyHandoffEpoch(input);
  if (verdict.kind === 'blocked' && verdict.reason !== 'handoff-before-or-at-reopen') return verdict;
  const reopened = [...input.events].reverse().find(event => event.type === 'REOPENED');
  if (!reopened) return blocked('no-reopen-event');
  if (input.handoffCreatedAt === reopened.at) return blocked('ambiguous-reopen-order');
  return { kind: 'checkpoint-epoch-evidence', relation: input.handoffCreatedAt < reopened.at ? 'prior' : 'current',
    issueNodeId: input.issueNodeId, commentNodeId: input.commentNodeId, commentId: input.commentId, commentDigest: input.commentDigest,
    epoch: { kind: 'reopened', anchor: reopened.id } };
}
