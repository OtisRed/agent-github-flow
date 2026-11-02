import { parseFlowComment } from './flow.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const timestamp = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value.replace('Z', '.000Z') ? time : null;
};

// Full pagination and mapping the GitHub actor's stable node ID are the
// caller's responsibility. This function does not authenticate API data.
export function selectLatestHandoff(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return blocked('invalid-input');
  if (input.complete !== true) return blocked('incomplete-comments');
  if (!Array.isArray(input.comments) || !Array.isArray(input.trustedAuthorIds)
    || input.trustedAuthorIds.length === 0 || input.trustedAuthorIds.some(id => typeof id !== 'string' || !id)
    || new Set(input.trustedAuthorIds).size !== input.trustedAuthorIds.length) return blocked('invalid-input');
  const trusted = new Set(input.trustedAuthorIds);
  const selected = [];
  const ids = new Set();
  const nodes = new Set();
  for (const comment of input.comments) {
    if (!comment || typeof comment !== 'object' || typeof comment.id !== 'string'
      || !/^[1-9][0-9]*$/.test(comment.id) || ids.has(comment.id)
      || typeof comment.nodeId !== 'string' || !comment.nodeId || nodes.has(comment.nodeId)
      || typeof comment.authorId !== 'string' || !comment.authorId) return blocked('invalid-comment-metadata');
    ids.add(comment.id);
    nodes.add(comment.nodeId);
    if (!trusted.has(comment.authorId)) continue;
    const created = timestamp(comment.createdAt);
    if (created === null || typeof comment.body !== 'string' || !Object.hasOwn(comment, 'lastEditedAt')
      || (comment.lastEditedAt !== null && timestamp(comment.lastEditedAt) === null)) return blocked('invalid-comment-metadata');
    selected.push({ comment, created });
  }
  if (!selected.length) return { kind: 'absent' };
  selected.sort((a, b) => b.created - a.created);
  if (selected.length > 1 && selected[0].created === selected[1].created) return blocked('ambiguous-order');
  const latest = selected[0].comment;
  if (latest.lastEditedAt !== null) return blocked('edited-latest-handoff');
  const parsed = parseFlowComment(latest.body);
  if (!parsed.ok) return blocked('invalid-latest-handoff');
  return { kind: 'handoff', id: latest.id, nodeId: latest.nodeId, authorId: latest.authorId, createdAt: latest.createdAt, body: latest.body, parsed };
}
