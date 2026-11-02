import { verifyHandoffEpoch } from './flow-epoch.mjs';

export const EPOCH_QUERY = `query FlowEpoch($owner: String!, $repo: String!, $number: Int!, $comment: ID!, $after: String) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      id state createdAt updatedAt
      timelineItems(first: 100, after: $after, itemTypes: [CLOSED_EVENT, REOPENED_EVENT]) {
        totalCount updatedAt pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on ClosedEvent { id createdAt }
          ... on ReopenedEvent { id createdAt }
        }
      }
    }
  }
  node(id: $comment) {
    ... on IssueComment { id createdAt issue { id } }
  }
}`;

const blocked = reason => ({ kind: 'blocked', reason });
const metadata = (issue, comment) => JSON.stringify([
  issue.id, issue.state, issue.createdAt, issue.updatedAt,
  issue.timelineItems.totalCount, issue.timelineItems.updatedAt,
  comment.id, comment.createdAt, comment.issue.id,
]);

// Read-only collector. graphql(query, variables) must return the full GraphQL
// response, including errors. Evidence is never a write permit.
export async function collectEpochEvidence(input) {
  if (!input || typeof input.graphql !== 'function' || typeof input.owner !== 'string' || !input.owner
    || typeof input.repo !== 'string' || !input.repo || !Number.isSafeInteger(input.number) || input.number < 1
    || typeof input.commentNodeId !== 'string' || !input.commentNodeId) return blocked('invalid-input');
  const { graphql, owner, repo, number, commentNodeId, observedAt } = input;
  const variables = { owner, repo, number, comment: commentNodeId };
  const fetchPage = async after => {
    let result;
    try { result = await graphql(EPOCH_QUERY, { ...variables, after }); } catch { return null; }
    if (!result || (result.errors != null && (!Array.isArray(result.errors) || result.errors.length)) || !result.data) return null;
    const issue = result.data.repository?.issue;
    const comment = result.data.node;
    const timeline = issue?.timelineItems;
    if (!issue || typeof issue.id !== 'string' || !issue.id || typeof issue.updatedAt !== 'string'
      || !comment || comment.id !== commentNodeId
      || comment.issue?.id !== issue.id || typeof comment.createdAt !== 'string'
      || !timeline || !Array.isArray(timeline.nodes) || !Number.isSafeInteger(timeline.totalCount)
      || timeline.totalCount < 0 || typeof timeline.updatedAt !== 'string'
      || typeof timeline.pageInfo?.hasNextPage !== 'boolean') return null;
    return { issue, comment, timeline };
  };
  let after = null;
  let baseline = null;
  let firstNodes = null;
  const seenCursors = new Set();
  const events = [];
  for (let page = 0; page < 100; page += 1) {
    const result = await fetchPage(after);
    if (!result) return blocked('unavailable-or-invalid-page');
    const current = metadata(result.issue, result.comment);
    if (baseline === null) { baseline = current; firstNodes = JSON.stringify([result.timeline.nodes, result.timeline.pageInfo]); }
    else if (baseline !== current) return blocked('snapshot-changed');
    for (const node of result.timeline.nodes) {
      if (!node || (node.__typename !== 'ClosedEvent' && node.__typename !== 'ReopenedEvent')) return blocked('invalid-event');
      events.push({ id: node.id, at: node.createdAt, type: node.__typename === 'ClosedEvent' ? 'CLOSED' : 'REOPENED' });
    }
    if (!result.timeline.pageInfo.hasNextPage) {
      if (events.length !== result.timeline.totalCount) return blocked('incomplete-timeline');
      const confirmation = await fetchPage(null);
      if (!confirmation || metadata(confirmation.issue, confirmation.comment) !== baseline
        || JSON.stringify([confirmation.timeline.nodes, confirmation.timeline.pageInfo]) !== firstNodes) return blocked('snapshot-changed');
      const epoch = verifyHandoffEpoch({ complete: true, issueState: result.issue.state,
        issueCreatedAt: result.issue.createdAt, handoffCreatedAt: result.comment.createdAt, observedAt, events });
      if (epoch.kind !== 'verified') return epoch;
      return { kind: 'evidence', epoch: 'consistent', eventCount: events.length };
    }
    const cursor = result.timeline.pageInfo.endCursor;
    if (typeof cursor !== 'string' || !cursor || seenCursors.has(cursor)) return blocked('invalid-cursor');
    seenCursors.add(cursor); after = cursor;
  }
  return blocked('page-limit');
}
