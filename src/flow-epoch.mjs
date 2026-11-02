const blocked = reason => ({ kind: 'blocked', reason });
const timestamp = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value.replace('Z', '.000Z') ? time : null;
};

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
