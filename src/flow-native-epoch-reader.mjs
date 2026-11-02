import { verifyNativeReopen } from './flow-epoch.mjs';

export const NATIVE_EPOCH_QUERY = `query FlowNativeEpoch($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      id state createdAt updatedAt
      timelineItems(first: 100, after: $after, itemTypes: [CLOSED_EVENT, REOPENED_EVENT]) {
        totalCount updatedAt pageInfo { hasNextPage endCursor }
        nodes { __typename ... on ClosedEvent { id createdAt } ... on ReopenedEvent { id createdAt } }
      }
    }
  }
}`;
const blocked = reason => ({ kind: 'blocked', reason });
const nonempty = value => typeof value === 'string' && value.length > 0;

// Read-only, requires the full native timeline even when no comment exists.
// Rechecking every page detects changes but does not create an atomic snapshot.
export async function collectNativeReopenEvidence(input) {
  if (!input || typeof input.graphql !== 'function' || !nonempty(input.owner) || !nonempty(input.repo)
    || !Number.isSafeInteger(input.number) || input.number < 1 || !nonempty(input.issueNodeId)) return blocked('invalid-input');
  const fetchPage = async after => {
    let result;
    try { result = await input.graphql(NATIVE_EPOCH_QUERY, { owner: input.owner, repo: input.repo, number: input.number, after }); }
    catch { return null; }
    if (!result || (result.errors != null && (!Array.isArray(result.errors) || result.errors.length)) || !result.data) return null;
    const issue = result.data.repository?.issue; const timeline = issue?.timelineItems;
    if (!issue || issue.id !== input.issueNodeId || !nonempty(issue.updatedAt) || !timeline
      || !Number.isSafeInteger(timeline.totalCount) || timeline.totalCount < 0 || !nonempty(timeline.updatedAt)
      || !Array.isArray(timeline.nodes) || typeof timeline.pageInfo?.hasNextPage !== 'boolean') return null;
    return issue;
  };
  const pages = []; const events = []; const cursors = new Set();
  let after = null; let header = null;
  for (let page = 0; page < 100; page += 1) {
    const issue = await fetchPage(after);
    if (!issue) return blocked('unavailable-or-invalid-page');
    const current = JSON.stringify([issue.id, issue.state, issue.createdAt, issue.updatedAt,
      issue.timelineItems.totalCount, issue.timelineItems.updatedAt]);
    if (header === null) header = current;
    else if (header !== current) return blocked('snapshot-changed');
    pages.push({ after, snapshot: JSON.stringify(issue) });
    for (const node of issue.timelineItems.nodes) {
      if (!node || !['ClosedEvent', 'ReopenedEvent'].includes(node.__typename)) return blocked('invalid-event');
      events.push({ id: node.id, at: node.createdAt, type: node.__typename === 'ClosedEvent' ? 'CLOSED' : 'REOPENED' });
    }
    if (!issue.timelineItems.pageInfo.hasNextPage) {
      if (events.length !== issue.timelineItems.totalCount) return blocked('incomplete-timeline');
      for (const original of pages) {
        const confirm = await fetchPage(original.after);
        if (!confirm || JSON.stringify(confirm) !== original.snapshot) return blocked('snapshot-changed');
      }
      const proof = verifyNativeReopen({ complete: true, issueNodeId: issue.id, issueState: issue.state,
        issueCreatedAt: issue.createdAt, observedAt: input.observedAt, events });
      return proof.kind === 'native-reopen-evidence' ? { ...proof, eventCount: events.length } : proof;
    }
    const cursor = issue.timelineItems.pageInfo.endCursor;
    if (!nonempty(cursor) || cursors.has(cursor)) return blocked('invalid-cursor');
    cursors.add(cursor); after = cursor;
  }
  return blocked('page-limit');
}
