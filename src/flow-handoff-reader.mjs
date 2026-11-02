import { selectLatestHandoff } from './flow-handoff.mjs';

export const HANDOFF_QUERY = `query FlowHandoffs($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      id state createdAt updatedAt
      comments(first: 100, after: $after) {
        totalCount pageInfo { hasNextPage endCursor }
        nodes {
          id fullDatabaseId body createdAt updatedAt lastEditedAt
          author { __typename ... on User { id } ... on Bot { id } }
        }
      }
    }
  }
}`;

const blocked = reason => ({ kind: 'blocked', reason });

// Read-only. The caller supplies trusted author IDs and an authenticated
// GraphQL transport; this reader is evidence, not permission to write.
export async function collectHandoffEvidence(input) {
  if (!input || typeof input.graphql !== 'function' || typeof input.owner !== 'string' || !input.owner
    || typeof input.repo !== 'string' || !input.repo || !Number.isSafeInteger(input.number) || input.number < 1
    || !Array.isArray(input.trustedAuthorIds) || input.trustedAuthorIds.length === 0
    || input.trustedAuthorIds.some(id => typeof id !== 'string' || !id)
    || new Set(input.trustedAuthorIds).size !== input.trustedAuthorIds.length
    || (input.cutoverAt !== undefined && input.checkpointCommentId !== undefined)
    || (input.checkpointCommentId !== undefined && (typeof input.checkpointCommentId !== 'string'
      || !/^[1-9][0-9]*$/.test(input.checkpointCommentId)))) return blocked('invalid-input');
  const { graphql, owner, repo, number, trustedAuthorIds } = input;
  const fetchPage = async after => {
    let response;
    try { response = await graphql(HANDOFF_QUERY, { owner, repo, number, after }); } catch { return null; }
    if (!response || (response.errors != null && (!Array.isArray(response.errors) || response.errors.length)) || !response.data) return null;
    const issue = response.data.repository?.issue;
    const comments = issue?.comments;
    if (!issue || typeof issue.id !== 'string' || !issue.id || typeof issue.state !== 'string'
      || typeof issue.createdAt !== 'string' || typeof issue.updatedAt !== 'string'
      || !comments || !Number.isSafeInteger(comments.totalCount) || comments.totalCount < 0
      || !Array.isArray(comments.nodes) || typeof comments.pageInfo?.hasNextPage !== 'boolean') return null;
    const nodes = [];
    for (const node of comments.nodes) {
      if (!node || typeof node.id !== 'string' || !node.id || typeof node.fullDatabaseId !== 'string'
        || !/^[1-9][0-9]*$/.test(node.fullDatabaseId) || typeof node.body !== 'string'
        || typeof node.createdAt !== 'string' || typeof node.updatedAt !== 'string'
        || !Object.hasOwn(node, 'lastEditedAt') || (node.lastEditedAt !== null && typeof node.lastEditedAt !== 'string')
        || !node.author || !['User', 'Bot'].includes(node.author.__typename)
        || typeof node.author.id !== 'string' || !node.author.id) return null;
      nodes.push({ id: node.fullDatabaseId, nodeId: node.id, body: node.body, createdAt: node.createdAt,
        updatedAt: node.updatedAt, lastEditedAt: node.lastEditedAt, authorId: node.author.id });
    }
    return { header: [issue.id, issue.state, issue.createdAt, issue.updatedAt, comments.totalCount],
      nodes, pageInfo: { hasNextPage: comments.pageInfo.hasNextPage, endCursor: comments.pageInfo.endCursor } };
  };
  const pages = [];
  const all = [];
  const cursors = new Set();
  let after = null;
  let header = null;
  let size = 0;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await fetchPage(after);
    if (!page) return blocked('unavailable-or-invalid-page');
    const currentHeader = JSON.stringify(page.header);
    if (header === null) header = currentHeader;
    else if (header !== currentHeader) return blocked('snapshot-changed');
    const snapshot = JSON.stringify(page);
    size += snapshot.length;
    if (size > 8_000_000) return blocked('size-limit');
    pages.push({ after, snapshot });
    all.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) {
      if (all.length !== page.header[4]) return blocked('incomplete-comments');
      for (const original of pages) {
        const confirmation = await fetchPage(original.after);
        if (!confirmation || JSON.stringify(confirmation) !== original.snapshot) return blocked('snapshot-changed');
      }
      const handoff = selectLatestHandoff({ complete: true, trustedAuthorIds, comments: all,
        ...(input.cutoverAt !== undefined ? { cutoverAt: input.cutoverAt } : {}) });
      if (handoff.kind === 'blocked') return handoff;
      if (input.checkpointCommentId !== undefined) {
        const previousComment = all.find(comment => comment.id === input.checkpointCommentId);
        if (!previousComment || !trustedAuthorIds.includes(previousComment.authorId) || previousComment.lastEditedAt !== null) {
          return blocked('checkpoint-comment-missing-or-untrusted');
        }
        return { kind: 'evidence', handoff, previousComment, commentCount: all.length };
      }
      return { kind: 'evidence', handoff, commentCount: all.length };
    }
    const cursor = page.pageInfo.endCursor;
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) return blocked('invalid-cursor');
    cursors.add(cursor); after = cursor;
  }
  return blocked('page-limit');
}
