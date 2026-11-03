import { isDeepStrictEqual } from 'node:util';
import { TextDecoder } from 'node:util';
import { planCheckpointCommit, planCheckpointV2Commit } from './flow-checkpoint-commit-plan.mjs';
import { readCheckpointInventory } from './flow-checkpoint-inventory-reader.mjs';
import { verifyPreparedCheckpointTree } from './flow-checkpoint-tree-diff.mjs';
import { CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF } from './flow-checkpoint-registration.mjs';

const oid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) && value !== '0'.repeat(40);
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(value);
const target = (value, ref, head) => value?.ref === ref && value.object?.type === 'commit' && value.object.sha === head;
const blocked = reason => ({ kind: 'blocked', reason });
const uncertain = () => ({ kind: 'object-preparation-uncertain', retryAllowed: false });

// Creates unreachable Git objects only, never moves refs. Intentionally limited
// to a token scoped to exactly one PRIVATE repo. Caller must authenticate the
// checkpoint snapshot, its registration, authors and ref policy; this module
// does not authorize publication or prove protection. Never log inputs/results.
export function createCheckpointObjectPreparer({ owner, repo, snapshot, after, registration, appToken, request = fetch } = {}) {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(owner ?? '') || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo ?? '')
      || ['.', '..'].includes(repo) || !token(appToken) || typeof request !== 'function'
      || snapshot?.repositoryFullName !== `${owner}/${repo}` || !oid(snapshot?.headOid)) throw Error('invalid-object-preparer');
  const plan = snapshot?.schemaVersion === 2 ? planCheckpointV2Commit({ snapshot, after, registration })
    : planCheckpointCommit({ snapshot, after });
  if (plan.kind !== 'checkpoint-commit-plan') throw Error('invalid-object-plan');
  const expected = structuredClone(snapshot); const additions = structuredClone(plan.additions);
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  let started = false;
  const call = async (url, method = 'GET', body) => {
    const response = await request(url, { method, redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${appToken}`,
        'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2026-03-10' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response || response.status !== (method === 'POST' ? 201 : 200) || typeof response.text !== 'function') throw Error('api-failed');
    const raw = await response.text();
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 8_000_000) throw Error('invalid-response');
    return JSON.parse(raw);
  };
  const get = path => call(`${api}${path}`);
  const scope = async () => {
    const result = await call('https://api.github.com/installation/repositories');
    const repoData = result?.repositories?.[0];
    return result?.total_count === 1 && Array.isArray(result.repositories) && result.repositories.length === 1
      && repoData?.node_id === expected.repositoryId && repoData.full_name === expected.repositoryFullName && repoData.private === true;
  };
  const refs = async () => [await get(`/git/ref/${CHECKPOINT_BRANCH_REF.slice('refs/'.length)}`),
    await get(`/git/ref/${CHECKPOINT_ANCHOR_REF.slice('refs/'.length)}`)];
  const stableRefs = values => target(values[0], CHECKPOINT_BRANCH_REF, expected.headOid)
    && target(values[1], CHECKPOINT_ANCHOR_REF, expected.headOid);
  const readCommit = sha => get(`/git/commits/${sha}`);
  const readTree = sha => get(`/git/trees/${sha}?recursive=1`);
  const readBlob = sha => get(`/git/blobs/${sha}`);
  return Object.freeze({ prepare: async () => {
    if (started) return blocked('preparer-already-used');
    started = true;
    let oldTree;
    try {
      if (!await scope() || !stableRefs(await refs())) return blocked('scope-or-ref-mismatch');
      const inventory = await readCheckpointInventory({ repositoryId: expected.repositoryId, commitOid: expected.headOid,
        selection: expected.selection, readCommit, readTree, readBlob,
        schemaVersion: expected.schemaVersion ?? 1, expectedCutoverAt: expected.cutoverAt });
      if (inventory.kind !== 'inventory-records-structurally-valid' || !isDeepStrictEqual(inventory.index, expected.index)
          || !isDeepStrictEqual(inventory.selectedRecord, expected.selectedRecord)) return blocked('snapshot-mismatch');
      oldTree = await readTree(inventory.treeOid);
      if (oldTree?.sha !== inventory.treeOid || oldTree.truncated !== false || !await scope() || !stableRefs(await refs())) {
        return blocked('preparation-preflight-changed');
      }
    } catch { return blocked('preparation-preflight-unavailable'); }
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const tree = await call(`${api}/git/trees`, 'POST', { base_tree: oldTree.sha,
        tree: additions.map(entry => ({ path: entry.path, mode: '100644', type: 'blob',
          content: decoder.decode(Buffer.from(entry.contents, 'base64')) })) });
      if (!oid(tree?.sha)) return uncertain();
      const newTree = await readTree(tree.sha);
      const diff = verifyPreparedCheckpointTree({ baseTreeOid: oldTree.sha, newTreeOid: tree.sha, baseTree: oldTree,
        newTree, additions });
      if (diff.kind !== 'prepared-tree-diff-verified' || !await scope() || !stableRefs(await refs())) return uncertain();
      const commit = await call(`${api}/git/commits`, 'POST', { message: 'Update FLOW checkpoint', tree: tree.sha, parents: [expected.headOid] });
      if (!oid(commit?.sha)) return uncertain();
      const actual = await readCommit(commit.sha);
      if (actual?.sha !== commit.sha || actual.tree?.sha !== tree.sha || !Array.isArray(actual.parents)
          || actual.parents.length !== 1 || actual.parents[0]?.sha !== expected.headOid
          || !await scope() || !stableRefs(await refs())) return uncertain();
      // The diff binds the exact canonical additions to the new tree. These
      // values remain private and are for a later guarded publication only.
      return { kind: 'checkpoint-objects-prepared', expectedHeadOid: expected.headOid,
        expectedTreeOid: tree.sha, commit: { sha: actual.sha, tree: { sha: tree.sha }, parents: [{ sha: expected.headOid }] } };
    } catch { return uncertain(); }
  } });
}
