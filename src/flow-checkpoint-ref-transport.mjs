import { planCheckpointRefPairAdvance } from './flow-checkpoint-ref-pair.mjs';
import { CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF } from './flow-checkpoint-registration.mjs';
import { isDeepStrictEqual } from 'node:util';
import { matchesHandoffSubject } from './flow-handoff-binding.mjs';
import { matchesV3ProtectedContext } from './flow-v3-protected-context.mjs';
import { verifyV3Preparation } from './flow-v3-preparation-guard.mjs';
import { verifyPreparedCheckpointTree } from './flow-checkpoint-tree-diff.mjs';

export const CHECKPOINT_UPDATE_REFS = `mutation FlowCheckpointUpdateRefs($input: UpdateRefsInput!) { updateRefs(input: $input) { __typename } }`;
const oid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) && value !== '0'.repeat(40);
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(value);
const blocked = reason => ({ kind: 'blocked', reason });
const uncertain = () => ({ kind: 'ref-update-uncertain', retryAllowed: false });

// Low-level, single-attempt App transport, not a controller or authorization
// boundary. The caller MUST first validate trusted registration, protection,
// single-writer ownership, data visibility and exact tree contents against a
// fresh authenticated plan. After every response it MUST read back both refs
// and the new inventory. It is not connected to a live workflow.
export function createCheckpointRefTransport({ owner, repo, repositoryId, expectedHeadOid, expectedTreeOid, commitOid,
  appToken, request = fetch } = {}) {
  return createTransport({owner,repo,repositoryId,expectedHeadOid,expectedTreeOid,commitOid,appToken,request,
    expectedPrivate:true,requireNotFork:false,additions:null});
}

// For v3, the exact tree changes are recomputed from the authenticated
// observation, not accepted as caller-provided additions. Protection,
// bootstrap, source authenticity and post-write readback remain external.
export function createV3CheckpointRefTransport({policy,projectRegistration,registrationCommitment,keyring,snapshot,after,v3,
  expectedTreeOid,commitOid,appToken,request=fetch}={}){
  try{
    policy=structuredClone(policy);projectRegistration=structuredClone(projectRegistration);registrationCommitment=structuredClone(registrationCommitment);
    snapshot=structuredClone(snapshot);after=structuredClone(after);
    const {keyring:ignored,...context}=v3;v3=structuredClone(context);
  }catch{throw Error('invalid-v3-ref-context');}
  if(!matchesV3ProtectedContext({policy,projectRegistration,registrationCommitment,keyring})
      ||!isDeepStrictEqual(v3.projectRegistration,projectRegistration)||!isDeepStrictEqual(snapshot,v3.checkpoint)
      ||!matchesHandoffSubject(v3,policy))throw Error('invalid-v3-ref-context');
  const registration=projectRegistration.checkpoint;
  const checked=verifyV3Preparation({...v3,checkpoint:snapshot,after,registration,keyring});
  if(checked.kind!=='v3-preparation-consistent')throw Error('invalid-v3-ref-plan');
  const parts=policy.repository.split('/');if(parts.length!==2)throw Error('invalid-v3-ref-context');
  return createTransport({owner:parts[0],repo:parts[1],repositoryId:policy.repositoryId,expectedHeadOid:checked.commit.expectedHeadOid,
    expectedTreeOid,commitOid,appToken,request,expectedPrivate:projectRegistration.expectedPrivate,requireNotFork:true,additions:checked.commit.additions});
}

function createTransport({ owner, repo, repositoryId, expectedHeadOid, expectedTreeOid, commitOid,
  appToken, request, expectedPrivate, requireNotFork, additions }) {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(owner ?? '') || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo ?? '') || ['.', '..'].includes(repo)
      || typeof repositoryId !== 'string' || !repositoryId || repositoryId.length > 256 || repositoryId.trim() !== repositoryId
      || !oid(expectedHeadOid) || !oid(expectedTreeOid) || !oid(commitOid) || expectedHeadOid === commitOid
      || !token(appToken) || typeof request !== 'function'||typeof expectedPrivate!=='boolean') throw Error('invalid-ref-transport');
  additions=additions===null?null:structuredClone(additions);
  const api = `https://api.github.com/repos/${owner}/${repo}`; let started = false;
  const call = async (url, method = 'GET', body) => {
    const response = await request(url, { method, redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${appToken}`,
        'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2026-03-10' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response || response.status !== 200 || typeof response.text !== 'function') throw Error('api-failed');
    const raw = await response.text();
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 2_000_000) throw Error('invalid-response');
    return JSON.parse(raw);
  };
  const get = path => call(`${api}${path}`);
  const scope = async () => {
    const installation = await call('https://api.github.com/installation/repositories'); const item = installation?.repositories?.[0];
    return installation?.total_count === 1 && Array.isArray(installation.repositories) && installation.repositories.length === 1
      && item?.node_id === repositoryId && item.full_name === `${owner}/${repo}` && item.private === expectedPrivate
      &&(!requireNotFork||item.fork===false);
  };
  return Object.freeze({ publish: async () => {
    if (started) return blocked('ref-transport-already-used'); started = true;
    let plan;
    try {
      if (!await scope()) return blocked('scope-mismatch');
      const repository = await get('');
      if (repository?.node_id !== repositoryId || repository.full_name !== `${owner}/${repo}` || repository.private !== expectedPrivate
          ||(requireNotFork&&repository.fork!==false)
          || typeof repository.default_branch !== 'string' || !repository.default_branch
          || [CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF].includes(`refs/heads/${repository.default_branch}`)) return blocked('repository-mismatch');
      const checkpointRef = await get(`/git/ref/${CHECKPOINT_BRANCH_REF.slice('refs/'.length)}`);
      const anchorRef = await get(`/git/ref/${CHECKPOINT_ANCHOR_REF.slice('refs/'.length)}`);
      const commit = await get(`/git/commits/${commitOid}`);
      if (commit?.sha !== commitOid) return blocked('commit-mismatch');
      plan = planCheckpointRefPairAdvance({ repositoryId, expectedHeadOid, expectedTreeOid, checkpointRef, anchorRef, commit });
      if (plan.kind !== 'atomic-ref-pair-plan') return blocked('invalid-ref-plan');
      if(additions!==null){
        const baseCommit=await get(`/git/commits/${expectedHeadOid}`);
        if(baseCommit?.sha!==expectedHeadOid||!oid(baseCommit.tree?.sha))return blocked('invalid-base-commit');
        const baseTree=await get(`/git/trees/${baseCommit.tree.sha}?recursive=1`),newTree=await get(`/git/trees/${expectedTreeOid}?recursive=1`);
        if(verifyPreparedCheckpointTree({baseTreeOid:baseCommit.tree.sha,newTreeOid:expectedTreeOid,baseTree,newTree,additions}).kind!=='prepared-tree-diff-verified')
          return blocked('prepared-tree-mismatch');
      }
      if (!await scope()) return blocked('scope-mismatch');
    } catch { return blocked('ref-preflight-unavailable'); }
    try {
      const response = await call('https://api.github.com/graphql', 'POST',
        { query: CHECKPOINT_UPDATE_REFS, variables: { input: { repositoryId, refUpdates: plan.refUpdates } } });
      if (!response || (Object.hasOwn(response, 'errors') && (!Array.isArray(response.errors) || response.errors.length !== 0))
          || response.data?.updateRefs?.__typename !== 'UpdateRefsPayload') return uncertain();
      return { kind: 'ref-update-acknowledged', retryAllowed: false };
    } catch { return uncertain(); }
  } });
}
