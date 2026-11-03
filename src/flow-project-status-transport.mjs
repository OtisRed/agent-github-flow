import { matchesV3ProtectedContext } from './flow-v3-protected-context.mjs';

export const BRANCH_STATUS_UPDATE = `mutation FlowBranchStatusUpdate($project: ID!, $item: ID!, $field: ID!, $value: ProjectV2FieldValue!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: $value }) { projectV2Item { id } }
}`;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(value);

// Internal capability for createV3ProjectStatusStep only: it binds the fixed
// Project and field, not an individual item. The step must freshly authenticate
// the PAT's Project access and bind item/issue and target before every use.
export function createV3BranchStatusTransport({policy,projectRegistration,registrationCommitment,keyring,projectToken,request=fetch}={}){
  try{policy=structuredClone(policy);projectRegistration=structuredClone(projectRegistration);registrationCommitment=structuredClone(registrationCommitment);}
  catch{throw Error('invalid-v3-status-transport');}
  if(!matchesV3ProtectedContext({policy,projectRegistration,registrationCommitment,keyring}))throw Error('invalid-v3-status-transport');
  return createBranchStatusTransport({projectToken,projectId:projectRegistration.projectId,statusFieldId:projectRegistration.statusFieldId,request});
}

// request is a trusted fetch-compatible transport. The protected caller must
// obtain projectId and statusFieldId from the same trusted route used by the
// status runner and bind each item to the intended issue before invocation.
// No arbitrary query, redirects, retries or response bodies are exposed.
export function createBranchStatusTransport({ projectToken, projectId, statusFieldId, request = fetch } = {}) {
  if (!id(projectToken) || !id(projectId) || !id(statusFieldId) || typeof request !== 'function') throw Error('invalid-status-transport');
  const setStatus = async ({ itemId, targetOptionId } = {}) => {
    if (!id(itemId) || !id(targetOptionId)) throw Error('invalid-status-target');
    try {
      const body = JSON.stringify({ query: BRANCH_STATUS_UPDATE, variables: { project: projectId, item: itemId,
        field: statusFieldId, value: { singleSelectOptionId: targetOptionId } } });
      const response = await request('https://api.github.com/graphql', { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${projectToken}`, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2026-03-10' }, body });
      if (!response || response.status !== 200 || typeof response.text !== 'function') return { kind: 'status-write-uncertain' };
      const raw = await response.text();
      if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 1_000_000) return { kind: 'status-write-uncertain' };
      const parsed = JSON.parse(raw);
      if (!parsed || (Object.hasOwn(parsed, 'errors') && (!Array.isArray(parsed.errors) || parsed.errors.length))
          || parsed.data?.updateProjectV2ItemFieldValue?.projectV2Item?.id !== itemId) return { kind: 'status-write-uncertain' };
      return { kind: 'status-write-acknowledged' };
    } catch { return { kind: 'status-write-uncertain' }; }
  };
  return Object.freeze({ projectId, statusFieldId, setStatus });
}
