import { readCheckpointTreePlan } from './flow-checkpoint-tree-reader.mjs';
import { decodeCheckpointRecordIdentity } from './flow-checkpoint-record-identity.mjs';
import { validateCheckpointInventory } from './flow-checkpoint-inventory.mjs';
import { encodeCheckpointRecord } from './flow-checkpoint-record.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const MAX_INVENTORY_BYTES = 16 * 1024 * 1024;

// Reads every record from the same immutable tree and checks its structure.
// The caller must independently validate public-data policy, branch registration,
// provenance and freshness. An optional selected record is private input to
// later verification, not a validated handoff; never log it. No writer or retry.
export async function readCheckpointInventory(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.readBlob !== 'function') return blocked('invalid-input');
  const { repositoryId, readBlob } = input;
  let selection = null;
  if (input.selection !== undefined) {
    if (!input.selection || typeof input.selection !== 'object' || Array.isArray(input.selection)
        || !Number.isSafeInteger(input.selection.number) || input.selection.number < 1
        || typeof input.selection.issueId !== 'string' || !input.selection.issueId || input.selection.issueId.length > 256
        || input.selection.issueId.trim() !== input.selection.issueId) return blocked('invalid-selection');
    selection = { number: input.selection.number, issueId: input.selection.issueId };
  }
  const plan = await readCheckpointTreePlan(input);
  if (plan.kind !== 'record-reads-planned') return plan;
  if (plan.records.reduce((sum, record) => sum + record.size, 0) > MAX_INVENTORY_BYTES) return blocked('inventory-too-large');
  const records = []; let selectedRecord = null;
  for (let i = 0; i < plan.records.length; i += 1) {
    const entry = plan.records[i]; const identity = plan.index.issues[i];
    let blob;
    try { blob = await readBlob(entry.oid); } catch { return blocked('record-read-failed'); }
    if (!blob || blob.size !== entry.size) return blocked('record-size-mismatch');
    const decoded = decodeCheckpointRecordIdentity({ expectedOid: entry.oid, blob, repositoryId,
      number: identity.number, issueId: identity.issueId });
    if (decoded.kind !== 'record-identity-verified') return decoded;
    const encoded = encodeCheckpointRecord(decoded.record);
    if (encoded.kind !== 'encoded-record') return encoded;
    if (encoded.content !== JSON.stringify(decoded.record)) return blocked('noncanonical-record');
    if (selection && identity.number === selection.number) {
      if (identity.issueId !== selection.issueId) return blocked('selection-identity-mismatch');
      selectedRecord = decoded.record;
    }
    const { version, repositoryId: recordRepositoryId, number, issueId } = decoded.record;
    records.push({ path: entry.path, value: { version, repositoryId: recordRepositoryId, number, issueId } });
  }
  const inventory = validateCheckpointInventory({ repositoryId, complete: true, index: plan.index, records });
  if (inventory.kind !== 'valid-inventory') return inventory;
  const result = { kind: 'inventory-records-structurally-valid', commitOid: plan.commitOid, treeOid: plan.treeOid,
    issueCount: inventory.issueCount, index: plan.index, records };
  return selection ? { ...result, selectedRecord } : result;
}
