import { CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF } from './flow-checkpoint-registration.mjs';
import { matchesV3ProtectedContext } from './flow-v3-protected-context.mjs';

const positive = value => Number.isSafeInteger(value) && value > 0;
const safeToken = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(value);

// Read-only, single-repository App transport. The caller must supply trusted
// configuration and check the observed App slug from token creation. This is
// not owner-audit evidence or permission to write. No API-provided URL is used.
export function createCheckpointProtectionTransport({ owner, repo, repositoryId, appToken, expectedSlug, actualSlug,
  updateRulesetId, historyRulesetId, request = fetch } = {}) {
  return createTransport({owner,repo,repositoryId,appToken,expectedSlug,actualSlug,updateRulesetId,historyRulesetId,request,expectedPrivate:true,requireNotFork:false});
}

// v3 binds visibility and exact rulesets to independently protected full
// configuration. This remains read-only and is not itself an owner audit.
export function createV3CheckpointProtectionTransport({policy,projectRegistration,registrationCommitment,keyring,
  appToken,expectedSlug,actualSlug,request=fetch}={}){
  try{policy=structuredClone(policy);projectRegistration=structuredClone(projectRegistration);registrationCommitment=structuredClone(registrationCommitment);}
  catch{throw Error('invalid-v3-protection-context');}
  if(!matchesV3ProtectedContext({policy,projectRegistration,registrationCommitment,keyring}))throw Error('invalid-v3-protection-context');
  const parts=policy.repository.split('/');if(parts.length!==2)throw Error('invalid-v3-protection-context');
  return createTransport({owner:parts[0],repo:parts[1],repositoryId:policy.repositoryId,appToken,expectedSlug,actualSlug,
    updateRulesetId:policy.updateRulesetId,historyRulesetId:policy.historyRulesetId,request,
    expectedPrivate:projectRegistration.expectedPrivate,requireNotFork:true});
}

function createTransport({ owner, repo, repositoryId, appToken, expectedSlug, actualSlug,
  updateRulesetId, historyRulesetId, request, expectedPrivate, requireNotFork }) {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(owner ?? '') || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo ?? '') || ['.','..'].includes(repo)
      || typeof repositoryId !== 'string' || !repositoryId || repositoryId.length > 256 || repositoryId.trim() !== repositoryId
      || !safeToken(appToken) || !/^[a-z0-9-]{1,100}$/.test(expectedSlug ?? '') || actualSlug !== expectedSlug
      || !positive(updateRulesetId) || !positive(historyRulesetId) || updateRulesetId === historyRulesetId
      || typeof request !== 'function'||typeof expectedPrivate!=='boolean') throw Error('invalid-protection-transport');
  const base = `/repos/${owner}/${repo}`;
  const refs = [CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF].map(ref => `${base}/rules/branches/${encodeURIComponent(ref.slice(11))}`);
  const plain = [base, `${base}/rulesets/${updateRulesetId}`, `${base}/rulesets/${historyRulesetId}`];
  const get = async url => {
    const response = await request(url, { method:'GET', redirect:'error', signal:AbortSignal.timeout(10000),
      headers:{ Accept:'application/vnd.github+json', Authorization:`Bearer ${appToken}`, 'X-GitHub-Api-Version':'2022-11-28' } });
    if (!response || response.status !== 200 || typeof response.text !== 'function' || typeof response.headers?.get !== 'function') throw Error('read-failed');
    const text = await response.text();
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 2000000) throw Error('invalid-response');
    return { data:JSON.parse(text), link:response.headers.get('link') };
  };
  return async raw => {
    let url; try { url = new URL(raw); } catch { throw Error('invalid-url'); }
    if (url.origin !== 'https://api.github.com' || url.username || url.password || url.hash) throw Error('invalid-url');
    const path = url.pathname;
    if (plain.includes(path)) { if (url.search) throw Error('invalid-url'); }
    else if (refs.includes(path)) {
      const keys = [...url.searchParams.keys()]; const pages = url.searchParams.getAll('page');
      if (keys.length !== 2 || url.searchParams.getAll('per_page').length !== 1 || url.searchParams.get('per_page') !== '100'
          || pages.length !== 1 || !/^[1-9][0-9]{0,2}$/.test(pages[0]) || Number(pages[0]) > 100) throw Error('invalid-url');
    } else throw Error('invalid-url');
    const installation = await get('https://api.github.com/installation/repositories');
    const items = installation.data?.repositories;
    if (installation.link || installation.data?.total_count !== 1 || !Array.isArray(items) || items.length !== 1
        || items[0]?.node_id !== repositoryId || items[0]?.full_name !== `${owner}/${repo}` || items[0]?.private !== expectedPrivate
        || (requireNotFork&&items[0]?.fork!==false)) throw Error('scope-mismatch');
    const result = await get(url.toString());
    return { status:200, json:async () => result.data, headers:{ get:name => name.toLowerCase() === 'link' ? result.link : null } };
  };
}
