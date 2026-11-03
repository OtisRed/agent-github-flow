// Historical test fixture for the superseded issue-body and Project checkpoint model.
// Never connect this fixture to live GitHub transports.
import { replaceFlowMarker, removeFlowMarker } from '../src/flow-marker.mjs';
import { planBootstrap } from '../src/flow-bootstrap.mjs';
import { isDeepStrictEqual } from 'node:util';
import { planTransitionSnapshot, transitionProjectValue } from '../src/flow-transition-runner.mjs';
import { planReentry } from '../src/flow-reentry.mjs';

export const PROJECT_WRITE = `mutation FlowProjectWrite($project: ID!, $item: ID!, $field: ID!, $value: ProjectV2FieldValue!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: $value }) { projectV2Item { id } }
}`;
export const ISSUE_WRITE = `mutation FlowIssueWrite($issue: ID!, $body: String!) {
  updateIssue(input: { id: $issue, body: $body }) { issue { id } }
}`;
const projectSteps = new Set(['write-bootstrap-witness', 'commit-project-checkpoint', 'normalize-project-checkpoint']);
const issueSteps = new Set(['write-issue-pending', 'commit-issue-marker']);
const nonempty = value => typeof value === 'string' && value.length > 0;
const dataOf = response => response && (!Object.hasOwn(response, 'errors')
  || (Array.isArray(response.errors) && response.errors.length === 0)) ? response.data : null;

// Only the predefined Project mutation receives the user transport; only the
// predefined issue mutation receives the App transport. Unknown queries fail.
export function createSplitWriteTransport({ projectGraphql, issueGraphql }) {
  if (typeof projectGraphql !== 'function' || typeof issueGraphql !== 'function') throw Error('invalid-transport');
  return (query, variables) => {
    if (query === PROJECT_WRITE) return projectGraphql(query, variables);
    if (query === ISSUE_WRITE) return issueGraphql(query, variables);
    throw Error('unsupported-query');
  };
}

// Low-level write adapter, not an authorization or concurrency mechanism.
// Call only with a freshly verified plan and re-read all state after writing.
export async function writeBootstrapGitHubStep({ graphql, snapshot, plan }) {
  if (typeof graphql !== 'function' || snapshot?.kind !== 'snapshot'
    || !['projectId', 'itemId', 'issueNodeId', 'statusFieldId', 'checkpointFieldId'].every(k => nonempty(snapshot[k]))) throw Error('invalid-snapshot');
  if (!isDeepStrictEqual(plan, planBootstrap(snapshot))) throw Error('plan-snapshot-mismatch');
  if (projectSteps.has(plan?.kind)) {
    if (!plan.witness || typeof plan.witness !== 'object') throw Error('invalid-witness');
    const result = dataOf(await graphql(PROJECT_WRITE, { project: snapshot.projectId, item: snapshot.itemId,
      field: snapshot.checkpointFieldId, value: { text: JSON.stringify(plan.witness) } }));
    if (result?.updateProjectV2ItemFieldValue?.projectV2Item?.id !== snapshot.itemId) throw Error('unconfirmed-project-write');
    return;
  }
  if (issueSteps.has(plan?.kind)) {
    const update = replaceFlowMarker(snapshot.issueBody, snapshot.marker, plan.marker);
    if (update.kind !== 'updated') throw Error('marker-conflict');
    const result = dataOf(await graphql(ISSUE_WRITE, { issue: snapshot.issueNodeId, body: update.body }));
    if (result?.updateIssue?.issue?.id !== snapshot.issueNodeId) throw Error('unconfirmed-issue-write');
    return;
  }
  if (plan?.kind === 'update-status') {
    const options = snapshot.statusOptions?.filter(option => option.name === plan.targetStatus) ?? [];
    if (options.length !== 1 || !nonempty(options[0].id) || snapshot.currentStatus !== plan.expectedStatus) throw Error('invalid-target-status');
    const result = dataOf(await graphql(PROJECT_WRITE, { project: snapshot.projectId, item: snapshot.itemId,
      field: snapshot.statusFieldId, value: { singleSelectOptionId: options[0].id } }));
    if (result?.updateProjectV2ItemFieldValue?.projectV2Item?.id !== snapshot.itemId) throw Error('unconfirmed-status-write');
    return;
  }
  throw Error('unsupported-step');
}

// Same bounded mutations for an ordinary post-bootstrap handoff; the caller
// must still re-read and establish source trust and exclusive ownership.
export async function writeTransitionGitHubStep({ graphql, snapshot, plan }) {
  if (typeof graphql !== 'function' || snapshot?.kind !== 'snapshot'
    || !['projectId', 'itemId', 'issueNodeId', 'statusFieldId', 'checkpointFieldId'].every(k => nonempty(snapshot[k]))) throw Error('invalid-snapshot');
  if (!isDeepStrictEqual(plan, planTransitionSnapshot(snapshot))) throw Error('plan-snapshot-mismatch');
  if (['start-handoff', 'commit-project-checkpoint'].includes(plan.kind)) {
    const witness = transitionProjectValue(plan);
    if (!witness) throw Error('invalid-witness');
    const result = dataOf(await graphql(PROJECT_WRITE, { project: snapshot.projectId, item: snapshot.itemId,
      field: snapshot.checkpointFieldId, value: { text: JSON.stringify(witness) } }));
    if (result?.updateProjectV2ItemFieldValue?.projectV2Item?.id !== snapshot.itemId) throw Error('unconfirmed-project-write');
    return;
  }
  if (issueSteps.has(plan.kind)) {
    const update = replaceFlowMarker(snapshot.issueBody, snapshot.marker, plan.marker);
    if (update.kind !== 'updated') throw Error('marker-conflict');
    const result = dataOf(await graphql(ISSUE_WRITE, { issue: snapshot.issueNodeId, body: update.body }));
    if (result?.updateIssue?.issue?.id !== snapshot.issueNodeId) throw Error('unconfirmed-issue-write');
    return;
  }
  if (plan.kind === 'update-status') {
    const options = snapshot.statusOptions?.filter(option => option.name === plan.targetStatus) ?? [];
    if (options.length !== 1 || !nonempty(options[0].id) || snapshot.currentStatus !== plan.expectedStatus) throw Error('invalid-target-status');
    const result = dataOf(await graphql(PROJECT_WRITE, { project: snapshot.projectId, item: snapshot.itemId,
      field: snapshot.statusFieldId, value: { singleSelectOptionId: options[0].id } }));
    if (result?.updateProjectV2ItemFieldValue?.projectV2Item?.id !== snapshot.itemId) throw Error('unconfirmed-status-write');
    return;
  }
  throw Error('unsupported-step');
}

export async function writeReentryGitHubStep({ graphql, snapshot, plan }) {
  if (typeof graphql !== 'function' || snapshot?.kind !== 'snapshot'
    || !['projectId', 'itemId', 'issueNodeId', 'statusFieldId', 'checkpointFieldId'].every(k => nonempty(snapshot[k]))) throw Error('invalid-snapshot');
  if (!isDeepStrictEqual(plan, planReentry(snapshot))) throw Error('plan-snapshot-mismatch');
  if (['start-reentry', 'finish-reentry'].includes(plan.kind)) {
    const result = dataOf(await graphql(PROJECT_WRITE, { project: snapshot.projectId, item: snapshot.itemId,
      field: snapshot.checkpointFieldId, value: { text: JSON.stringify(plan.witness) } }));
    if (result?.updateProjectV2ItemFieldValue?.projectV2Item?.id !== snapshot.itemId) throw Error('unconfirmed-project-write');
    return;
  }
  if (plan.kind === 'remove-issue-marker') {
    const update = removeFlowMarker(snapshot.issueBody, plan.marker);
    if (update.kind !== 'updated') throw Error('marker-conflict');
    const result = dataOf(await graphql(ISSUE_WRITE, { issue: snapshot.issueNodeId, body: update.body }));
    if (result?.updateIssue?.issue?.id !== snapshot.issueNodeId) throw Error('unconfirmed-issue-write');
    return;
  }
  if (plan.kind === 'update-status') {
    const options = snapshot.statusOptions?.filter(option => option.name === plan.targetStatus) ?? [];
    if (options.length !== 1 || !nonempty(options[0].id) || snapshot.currentStatus !== plan.expectedStatus) throw Error('invalid-target-status');
    const result = dataOf(await graphql(PROJECT_WRITE, { project: snapshot.projectId, item: snapshot.itemId,
      field: snapshot.statusFieldId, value: { singleSelectOptionId: options[0].id } }));
    if (result?.updateProjectV2ItemFieldValue?.projectV2Item?.id !== snapshot.itemId) throw Error('unconfirmed-status-write');
    return;
  }
  throw Error('unsupported-step');
}
