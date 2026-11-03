import { readFlowMarker } from './flow-marker.mjs';

export const SPLIT_PROJECT_QUERY = `query FlowSplitProject($owner: String!, $number: Int!, $item: ID!, $statusName: String!, $checkpointName: String!) {
  user(login: $owner) { projectV2(number: $number) { id } }
  node(id: $item) {
    ... on ProjectV2Item {
      id isArchived project {
        id
        statusField: field(name: $statusName) { ... on ProjectV2SingleSelectField { id name dataType options { id name } } }
        checkpointField: field(name: $checkpointName) { ... on ProjectV2Field { id name dataType } }
      }
      status: fieldValueByName(name: $statusName) { ... on ProjectV2ItemFieldSingleSelectValue { name optionId field { ... on ProjectV2SingleSelectField { id } } } }
      checkpoint: fieldValueByName(name: $checkpointName) { ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { id } } } }
    }
  }
}`;
export const BRANCH_PROJECT_QUERY = `query FlowBranchProject($owner: String!, $number: Int!, $item: ID!, $statusName: String!) {
  user(login: $owner) { projectV2(number: $number) { id } }
  node(id: $item) {
    ... on ProjectV2Item {
      id isArchived project {
        id
        statusField: field(name: $statusName) { ... on ProjectV2SingleSelectField { id name dataType options { id name } } }
      }
      status: fieldValueByName(name: $statusName) { ... on ProjectV2ItemFieldSingleSelectValue { name optionId field { ... on ProjectV2SingleSelectField { id } } } }
    }
  }
}`;
export const SPLIT_ISSUE_QUERY = `query FlowSplitIssue($issue: ID!) {
  node(id: $issue) { ... on Issue { id number state body updatedAt repository { nameWithOwner } } }
}`;
export const BRANCH_ISSUE_QUERY = `query FlowBranchIssue($issue: ID!) {
  node(id: $issue) { ... on Issue { id number state updatedAt repository { nameWithOwner } } }
}`;

const blocked = reason => ({ kind: 'blocked', reason });
const nonempty = value => typeof value === 'string' && value.length > 0;
const dataOf = response => response && (!Object.hasOwn(response, 'errors')
  || (Array.isArray(response.errors) && response.errors.length === 0)) ? response.data : null;

// Reads Project fields with the user token, issue data with the App token,
// and the item/content binding through the user-owned Project REST API.
// listItems receives only validated owner/number and an opaque next cursor;
// its transport must constrain requests to the expected GitHub API endpoint.
export async function readSplitProjectIssue(input) { return readProjectIssue(input, false); }

// Branch checkpoints require no Project checkpoint field and never parse an
// issue-body marker. This remains an observation, not authority to write.
export async function readBranchProjectIssue(input) { return readProjectIssue(input, true); }

async function readProjectIssue(input, branchCheckpoint) {
  if (!input || typeof input.projectGraphql !== 'function' || typeof input.issueGraphql !== 'function'
    || typeof input.listItems !== 'function' || !['projectId', 'itemId', 'issueId', 'repository', 'projectOwner',
      'statusFieldId', 'statusFieldName'].every(k => nonempty(input[k]))
    || !/^[A-Za-z0-9-]{1,39}$/.test(input.projectOwner) || !Number.isSafeInteger(input.projectNumber) || input.projectNumber < 1
    || !Number.isSafeInteger(input.number) || input.number < 1
    || (!branchCheckpoint && (!nonempty(input.checkpointFieldId) || !nonempty(input.checkpointFieldName)
      || input.statusFieldId === input.checkpointFieldId || input.statusFieldName === input.checkpointFieldName))) return blocked('invalid-input');
  const projectVars = { owner: input.projectOwner, number: input.projectNumber, item: input.itemId,
    statusName: input.statusFieldName, ...(!branchCheckpoint ? { checkpointName: input.checkpointFieldName } : {}) };
  const getProject = async () => {
    try { return dataOf(await input.projectGraphql(branchCheckpoint ? BRANCH_PROJECT_QUERY : SPLIT_PROJECT_QUERY, projectVars)); } catch { return null; }
  };
  const getIssue = async () => {
    try { return dataOf(await input.issueGraphql(branchCheckpoint ? BRANCH_ISSUE_QUERY : SPLIT_ISSUE_QUERY, { issue: input.issueId }))?.node ?? null; } catch { return null; }
  };
  const first = await getProject(); const issue = await getIssue(); const item = first?.node;
  if (first?.user?.projectV2?.id !== input.projectId || item?.id !== input.itemId || item.isArchived !== false
    || item.project?.id !== input.projectId) return blocked('invalid-item');
  if (issue?.id !== input.issueId || issue.repository?.nameWithOwner !== input.repository
    || issue.number !== input.number || !['OPEN', 'CLOSED'].includes(issue.state)
    || (!branchCheckpoint && typeof issue.body !== 'string') || !nonempty(issue.updatedAt)) return blocked('invalid-issue');
  const statusField = item.project.statusField; const checkpointField = item.project.checkpointField;
  if (statusField?.id !== input.statusFieldId || statusField.name !== input.statusFieldName || statusField.dataType !== 'SINGLE_SELECT'
    || !Array.isArray(statusField.options) || (!branchCheckpoint && (checkpointField?.id !== input.checkpointFieldId
    || checkpointField.name !== input.checkpointFieldName || checkpointField.dataType !== 'TEXT'))) return blocked('invalid-fields');
  if (statusField.options.some(o => !nonempty(o?.id) || !nonempty(o?.name))
    || new Set(statusField.options.map(o => o.id)).size !== statusField.options.length
    || new Set(statusField.options.map(o => o.name)).size !== statusField.options.length) return blocked('invalid-options');
  if (!item.status || item.status.field?.id !== input.statusFieldId || !nonempty(item.status.optionId)
    || !statusField.options.some(o => o.id === item.status.optionId && o.name === item.status.name)) return blocked('invalid-status');
  if (!branchCheckpoint && item.checkpoint !== null && (!item.checkpoint || item.checkpoint.field?.id !== input.checkpointFieldId
    || typeof item.checkpoint.text !== 'string')) return blocked('invalid-checkpoint-field');
  let witness = null;
  if (!branchCheckpoint && item.checkpoint !== null) {
    try { witness = JSON.parse(item.checkpoint.text); } catch { return blocked('invalid-checkpoint-json'); }
    if (!witness || typeof witness !== 'object' || Array.isArray(witness)) return blocked('invalid-checkpoint-json');
  }
  const marker = branchCheckpoint ? null : readFlowMarker(issue.body);
  if (!branchCheckpoint && marker.kind === 'blocked') return marker;
  const fetchPage = async after => {
    let page;
    try { page = await input.listItems({ owner: input.projectOwner, projectNumber: input.projectNumber, after }); } catch { return null; }
    if (!page || !Array.isArray(page.items) || !(page.nextCursor === null || nonempty(page.nextCursor))) return null;
    for (const entry of page.items) {
      if (!entry || !nonempty(entry.nodeId) || typeof entry.archived !== 'boolean'
        || !['Issue', 'PullRequest', 'DraftIssue'].includes(entry.contentType)
        || (!entry.archived && !nonempty(entry.contentNodeId))) return null;
    }
    return page;
  };
  const pages = []; const items = []; const cursors = new Set(); let after = null; let size = 0;
  for (let n = 0; n < 100; n += 1) {
    const page = await fetchPage(after);
    if (!page) return blocked('invalid-item-page');
    const serialized = JSON.stringify(page); size += serialized.length;
    if (size > 8_000_000) return blocked('size-limit');
    pages.push({ after, serialized }); items.push(...page.items);
    if (page.nextCursor === null) {
      if (new Set(items.map(entry => entry.nodeId)).size !== items.length) return blocked('duplicate-card');
      const matching = items.filter(entry => !entry.archived && entry.contentType === 'Issue' && entry.contentNodeId === input.issueId);
      if (matching.length !== 1 || matching[0].nodeId !== input.itemId) return blocked('ambiguous-card');
      for (const prior of pages) {
        const confirmation = await fetchPage(prior.after);
        if (!confirmation || JSON.stringify(confirmation) !== prior.serialized) return blocked('snapshot-changed');
      }
      const projectAgain = await getProject(); const issueAgain = await getIssue();
      if (JSON.stringify(projectAgain) !== JSON.stringify(first) || JSON.stringify(issueAgain) !== JSON.stringify(issue)) return blocked('snapshot-changed');
      if (branchCheckpoint) return { kind: 'branch-project-observed', projectId: input.projectId, itemId: input.itemId,
        repository: input.repository, statusFieldId: input.statusFieldId, issueNodeId: input.issueId, issueState: issue.state,
        issueUpdatedAt: issue.updatedAt, currentStatus: item.status.name, statusOptionId: item.status.optionId,
        statusOptions: structuredClone(statusField.options) };
      return { kind: 'snapshot', projectId: input.projectId, itemId: input.itemId, repository: input.repository,
        statusFieldId: input.statusFieldId, checkpointFieldId: input.checkpointFieldId,
        issueNodeId: input.issueId, issueState: issue.state, issueBody: issue.body, issueUpdatedAt: issue.updatedAt,
        currentStatus: item.status.name, statusOptionId: item.status.optionId, statusOptions: structuredClone(statusField.options),
        marker: marker.kind === 'found' ? marker.marker : null, witness, witnessText: item.checkpoint?.text ?? null };
    }
    if (cursors.has(page.nextCursor)) return blocked('invalid-cursor');
    cursors.add(page.nextCursor); after = page.nextCursor;
  }
  return blocked('page-limit');
}
