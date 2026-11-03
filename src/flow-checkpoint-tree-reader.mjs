import { planCheckpointRecordReads } from './flow-checkpoint-tree.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const oid = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);

// The supplied read-only transport must call the selected repository's Git
// commit, recursive tree and blob endpoints. The caller is responsible for
// binding commitOid to the registered branch and authorized repository.
// A successful plan does not verify record bytes, branch history or rollback.
export async function readCheckpointTreePlan(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !oid(input.commitOid)
      || typeof input.repositoryId !== 'string' || !input.repositoryId
      || typeof input.readCommit !== 'function' || typeof input.readTree !== 'function'
      || typeof input.readBlob !== 'function') return blocked('invalid-input');
  const { commitOid, repositoryId, readCommit, readTree, readBlob } = input;
  let commit;
  try { commit = await readCommit(commitOid); }
  catch { return blocked('commit-read-failed'); }
  if (!commit || commit.sha !== commitOid || !oid(commit.tree?.sha)) return blocked('invalid-commit');
  const treeOid = commit.tree.sha;
  let tree;
  try { tree = structuredClone(await readTree(treeOid, { recursive: true })); }
  catch { return blocked('tree-read-failed'); }
  if (!tree || tree.sha !== treeOid || tree.truncated !== false || !Array.isArray(tree.tree)
      || tree.tree.length > 10002) return blocked('incomplete-or-invalid-tree');
  const indexes = tree.tree.filter(entry => entry?.path === 'index.json');
  if (indexes.length !== 1 || !oid(indexes[0].sha)) return blocked('missing-or-invalid-index');
  let indexBlob;
  try { indexBlob = await readBlob(indexes[0].sha); }
  catch { return blocked('index-read-failed'); }
  const result = planCheckpointRecordReads({ expectedTreeOid: treeOid, repositoryId, tree, indexBlob });
  return result.kind === 'record-reads-planned' ? { ...result, commitOid, treeOid } : result;
}
