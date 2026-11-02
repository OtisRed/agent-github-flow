import { readFlowMarker } from './flow-marker.mjs';

export const PROJECT_ITEM_QUERY = `query FlowProjectItem($item: ID!, $statusName: String!, $checkpointName: String!) {
  node(id: $item) {
    ... on ProjectV2Item {
      id isArchived
      project {
        id
        statusField: field(name: $statusName) {
          ... on ProjectV2SingleSelectField { id name dataType options { id name } }
        }
        checkpointField: field(name: $checkpointName) {
          ... on ProjectV2Field { id name dataType }
        }
      }
      content { ... on Issue { id number state body updatedAt repository { nameWithOwner } } }
      status: fieldValueByName(name: $statusName) {
        ... on ProjectV2ItemFieldSingleSelectValue { name optionId field { ... on ProjectV2SingleSelectField { id } } }
      }
      checkpoint: fieldValueByName(name: $checkpointName) {
        ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { id } } }
      }
    }
  }
}`;

export const ISSUE_CARDS_QUERY = `query FlowIssueCards($issue: ID!, $after: String) {
  node(id: $issue) {
    ... on Issue {
      id updatedAt
      projectItems(first: 100, after: $after) {
        totalCount pageInfo { hasNextPage endCursor }
        nodes { id isArchived project { id } }
      }
    }
  }
}`;

const blocked = reason => ({ kind: 'blocked', reason });
const nonempty = value => typeof value === 'string' && value.length > 0;
const dataOf = response => response && (!Object.hasOwn(response, 'errors')
  || (Array.isArray(response.errors) && response.errors.length === 0)) ? response.data : null;

// Read-only adapter. Explicit IDs bind every result to the caller's selected
// repo, issue, Project, card and fields; no credentials are inspected here.
// The two-pass card read detects some changes, not an atomic snapshot.
export async function readProjectIssue(input) {
  if (!input || typeof input.graphql !== 'function' || !['projectId', 'itemId', 'issueId', 'repository',
    'statusFieldId', 'statusFieldName', 'checkpointFieldId', 'checkpointFieldName'].every(key => nonempty(input[key]))
    || input.statusFieldId === input.checkpointFieldId || input.statusFieldName === input.checkpointFieldName) return blocked('invalid-input');
  const variables = { item: input.itemId, statusName: input.statusFieldName, checkpointName: input.checkpointFieldName };
  const fetchItem = async () => {
    try { return dataOf(await input.graphql(PROJECT_ITEM_QUERY, variables))?.node ?? null; } catch { return null; }
  };
  const first = await fetchItem();
  if (!first || first.id !== input.itemId || first.isArchived !== false || first.project?.id !== input.projectId
    || first.content?.id !== input.issueId || first.content?.repository?.nameWithOwner !== input.repository
    || !Number.isSafeInteger(first.content?.number) || typeof first.content?.body !== 'string'
    || !['OPEN', 'CLOSED'].includes(first.content?.state) || !nonempty(first.content?.updatedAt)) return blocked('invalid-item');
  const statusField = first.project.statusField;
  const checkpointField = first.project.checkpointField;
  if (statusField?.id !== input.statusFieldId || statusField.name !== input.statusFieldName || statusField.dataType !== 'SINGLE_SELECT'
    || !Array.isArray(statusField.options) || checkpointField?.id !== input.checkpointFieldId
    || checkpointField.name !== input.checkpointFieldName || checkpointField.dataType !== 'TEXT') return blocked('invalid-fields');
  if (statusField.options.some(o => !nonempty(o?.id) || !nonempty(o?.name))
    || new Set(statusField.options.map(o => o.id)).size !== statusField.options.length
    || new Set(statusField.options.map(o => o.name)).size !== statusField.options.length) return blocked('invalid-options');
  if (!first.status || first.status.field?.id !== input.statusFieldId || !nonempty(first.status.optionId)
    || !statusField.options.some(o => o.id === first.status.optionId && o.name === first.status.name)) return blocked('invalid-status');
  if (first.checkpoint !== null && (!first.checkpoint || first.checkpoint.field?.id !== input.checkpointFieldId
    || typeof first.checkpoint.text !== 'string')) return blocked('invalid-checkpoint-field');
  let witness = null;
  if (first.checkpoint !== null) {
    try { witness = JSON.parse(first.checkpoint.text); } catch { return blocked('invalid-checkpoint-json'); }
    if (!witness || typeof witness !== 'object' || Array.isArray(witness)) return blocked('invalid-checkpoint-json');
  }
  const marker = readFlowMarker(first.content.body);
  if (marker.kind === 'blocked') return marker;
  const pages = [];
  const cards = [];
  const cursors = new Set();
  let after = null;
  let header = null;
  for (let page = 0; page < 100; page += 1) {
    const fetchCards = async cursor => {
      let result;
      try { result = dataOf(await input.graphql(ISSUE_CARDS_QUERY, { issue: input.issueId, after: cursor }))?.node; } catch { return null; }
      const connection = result?.projectItems;
      if (result?.id !== input.issueId || !nonempty(result.updatedAt) || !connection || !Number.isSafeInteger(connection.totalCount)
        || connection.totalCount < 0 || !Array.isArray(connection.nodes) || typeof connection.pageInfo?.hasNextPage !== 'boolean'
        || connection.nodes.some(card => !nonempty(card?.id) || typeof card.isArchived !== 'boolean' || !nonempty(card.project?.id))) return null;
      return result;
    };
    const result = await fetchCards(after);
    if (!result) return blocked('invalid-card-page');
    const currentHeader = JSON.stringify([result.id, result.updatedAt, result.projectItems.totalCount]);
    if (header === null) header = currentHeader;
    else if (header !== currentHeader) return blocked('snapshot-changed');
    pages.push({ after, snapshot: JSON.stringify(result) });
    cards.push(...result.projectItems.nodes);
    if (!result.projectItems.pageInfo.hasNextPage) {
      if (cards.length !== result.projectItems.totalCount || new Set(cards.map(card => card.id)).size !== cards.length) return blocked('incomplete-cards');
      for (const original of pages) {
        const confirmation = await fetchCards(original.after);
        if (!confirmation || JSON.stringify(confirmation) !== original.snapshot) return blocked('snapshot-changed');
      }
      const matching = cards.filter(card => card.project.id === input.projectId && !card.isArchived);
      if (matching.length !== 1 || matching[0].id !== input.itemId) return blocked('ambiguous-card');
      const final = await fetchItem();
      if (!final || JSON.stringify(final) !== JSON.stringify(first) || result.updatedAt !== first.content.updatedAt) return blocked('snapshot-changed');
      return { kind: 'snapshot', projectId: input.projectId, itemId: input.itemId, repository: input.repository,
        statusFieldId: input.statusFieldId, checkpointFieldId: input.checkpointFieldId,
        issueNodeId: input.issueId, issueState: first.content.state, issueBody: first.content.body,
        issueUpdatedAt: first.content.updatedAt, currentStatus: first.status.name, statusOptionId: first.status.optionId,
        statusOptions: structuredClone(statusField.options), marker: marker.kind === 'found' ? marker.marker : null, witness,
        witnessText: first.checkpoint?.text ?? null };
    }
    const cursor = result.projectItems.pageInfo.endCursor;
    if (!nonempty(cursor) || cursors.has(cursor)) return blocked('invalid-cursor');
    cursors.add(cursor); after = cursor;
  }
  return blocked('page-limit');
}
