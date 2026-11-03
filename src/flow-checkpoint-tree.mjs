import { decodeCheckpointIndexBlob } from './flow-checkpoint-index-blob.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const oid = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const plainFile = entry => entry?.type === 'blob' && entry.mode === '100644'
  && oid(entry.sha) && Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= 1024 * 1024;

// Plans reads from one recursive Git Trees response. The caller must bind the
// expected tree to a verified commit/ref and fetch each listed record by OID;
// this function does not verify record contents or prove branch provenance.
export function planCheckpointRecordReads(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !oid(input.expectedTreeOid)) return blocked('invalid-input');
  const { tree, expectedTreeOid, repositoryId, indexBlob } = input;
  if (!tree || typeof tree !== 'object' || tree.sha !== expectedTreeOid || tree.truncated !== false
      || !Array.isArray(tree.tree) || tree.tree.length > 10002) return blocked('incomplete-or-invalid-tree');
  const paths = new Map();
  for (const entry of tree.tree) {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || paths.has(entry.path)) return blocked('invalid-tree-entry');
    paths.set(entry.path, entry);
  }
  const indexEntry = paths.get('index.json');
  if (!plainFile(indexEntry)) return blocked('missing-or-invalid-index');
  if (!indexBlob || indexBlob.size !== indexEntry.size) return blocked('index-size-mismatch');
  const index = decodeCheckpointIndexBlob({ expectedOid: indexEntry.sha, repositoryId, blob: indexBlob });
  if (index.kind !== 'decoded-index') return index;
  const directory = paths.get('issues');
  if (directory && (directory.type !== 'tree' || directory.mode !== '040000' || !oid(directory.sha))) return blocked('invalid-issues-directory');
  const recordPaths = new Map();
  for (const [path, entry] of paths) {
    if (!path.startsWith('issues/')) continue;
    if (!/^issues\/[1-9][0-9]*\.json$/.test(path) || !plainFile(entry)) return blocked('invalid-record-entry');
    recordPaths.set(path, entry);
  }
  if (recordPaths.size && !directory) return blocked('missing-issues-directory');
  if (recordPaths.size !== index.index.issues.length) return blocked('inventory-count-mismatch');
  const records = [];
  for (const issue of index.index.issues) {
    const path = `issues/${issue.number}.json`;
    const entry = recordPaths.get(path);
    if (!entry) return blocked('inventory-path-mismatch');
    records.push({ path, oid: entry.sha, size: entry.size });
  }
  return { kind: 'record-reads-planned', index: index.index, records };
}
