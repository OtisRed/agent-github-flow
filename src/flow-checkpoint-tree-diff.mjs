import { createHash } from 'node:crypto';

const blocked = reason => ({ kind: 'blocked', reason });
const oid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) && value !== '0'.repeat(40);
const base64 = value => typeof value === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  && Buffer.from(value, 'base64').toString('base64') === value;
const blobOid = contents => { const bytes = Buffer.from(contents, 'base64');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); };

function entries(tree, expected) {
  if (!tree || tree.sha !== expected || tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > 10002) return null;
  const result = new Map();
  for (const entry of tree.tree) {
    if (!entry || typeof entry.path !== 'string' || !entry.path || result.has(entry.path) || !oid(entry.sha)
        || typeof entry.mode !== 'string' || !['blob', 'tree', 'commit'].includes(entry.type)) return null;
    result.set(entry.path, { mode: entry.mode, type: entry.type, sha: entry.sha });
  }
  return result;
}

// Compare complete recursive tree observations with the exact two additions.
// Caller must bind both tree OIDs to trusted commits in the same repository and
// authenticate the checkpoint plan. This does not publish or authorize writes.
export function verifyPreparedCheckpointTree(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !oid(input.baseTreeOid) || !oid(input.newTreeOid)
      || input.baseTreeOid === input.newTreeOid
      || !Array.isArray(input.additions) || input.additions.length !== 2) return blocked('invalid-input');
  const [index, record] = input.additions;
  if (index?.path !== 'index.json' || !/^issues\/[1-9][0-9]*\.json$/.test(record?.path ?? '')
      || typeof index.contents !== 'string' || typeof record.contents !== 'string'
      || index.contents.length > 1_400_000 || record.contents.length > 24_000
      || !base64(index.contents) || !base64(record.contents)) {
    return blocked('invalid-additions');
  }
  const oldEntries = entries(input.baseTree, input.baseTreeOid);
  const newEntries = entries(input.newTree, input.newTreeOid);
  if (!oldEntries || !newEntries) return blocked('invalid-tree');
  const oldIndex = oldEntries.get('index.json'); const directory = newEntries.get('issues');
  if (oldIndex?.type !== 'blob' || oldIndex.mode !== '100644'
      || directory?.type !== 'tree' || directory.mode !== '040000') return blocked('invalid-tree-layout');
  const oldDirectory = oldEntries.get('issues');
  if (oldDirectory && (oldDirectory.type !== 'tree' || oldDirectory.mode !== '040000')) return blocked('invalid-tree-layout');
  for (const item of [index, record]) {
    const entry = newEntries.get(item.path);
    if (entry?.type !== 'blob' || entry.mode !== '100644' || entry.sha !== blobOid(item.contents)) return blocked('addition-mismatch');
  }
  const changed = new Set(['index.json', record.path, 'issues']);
  for (const [path, entry] of oldEntries) {
    if (changed.has(path)) continue;
    if (JSON.stringify(entry) !== JSON.stringify(newEntries.get(path))) return blocked('unrelated-tree-change');
  }
  for (const path of newEntries.keys()) {
    if (!changed.has(path) && !oldEntries.has(path)) return blocked('unrelated-tree-change');
  }
  return { kind: 'prepared-tree-diff-verified' };
}
