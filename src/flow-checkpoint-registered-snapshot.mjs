import { isCheckpointRegistration } from './flow-checkpoint-registration.mjs';
import { readCheckpointRegistration } from './flow-checkpoint-registration-reader.mjs';
import { readCheckpointInventory } from './flow-checkpoint-inventory-reader.mjs';

const blocked = reason => ({ kind: 'blocked', reason });

// A read-only composition. The caller supplies trusted configuration and App
// transports. Neither a matching genesis nor this snapshot proves rollback
// protection, comment truth, one writer or an atomic Project/Git state.
export async function readRegisteredCheckpointSnapshot(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return blocked('invalid-input');
  if (input.registration === null || input.registration === undefined) return blocked('not-registered');
  if (!isCheckpointRegistration(input.registration)) return blocked('invalid-registration');
  const schemaVersion = Object.hasOwn(input.registration, 'checkpointSchemaVersion') ? input.registration.checkpointSchemaVersion : 1;
  if (![1, 2].includes(schemaVersion)) return blocked('invalid-schema-version');
  if (!input.selection || typeof input.selection !== 'object' || Array.isArray(input.selection)
      || !Number.isSafeInteger(input.selection.number) || input.selection.number < 1
      || typeof input.selection.issueId !== 'string' || !input.selection.issueId || input.selection.issueId.length > 256
      || input.selection.issueId.trim() !== input.selection.issueId) return blocked('invalid-selection');
  const registration = structuredClone(input.registration);
  const selection = { number: input.selection.number, issueId: input.selection.issueId };
  const { readRepository, readRef, compare, readCommit, readTree, readBlob } = input;
  const registrationInput = { registration, readRepository, readRef, compare };
  const first = await readCheckpointRegistration(registrationInput);
  if (first.kind !== 'genesis-ancestry-observed') return first;
  if (first.pairedRefs !== true) return blocked('anchor-unverified');
  const inventory = await readCheckpointInventory({ repositoryId: registration.repositoryId, commitOid: first.headOid,
    selection, readCommit, readTree, readBlob, schemaVersion, expectedCutoverAt: registration.cutoverAt });
  if (inventory.kind !== 'inventory-records-structurally-valid') return inventory;
  if (inventory.commitOid !== first.headOid) return blocked('inventory-head-mismatch');
  if (inventory.selectedRecord && inventory.selectedRecord.cutoverAt !== registration.cutoverAt) return blocked('cutover-mismatch');
  const last = await readCheckpointRegistration(registrationInput);
  if (last.kind !== 'genesis-ancestry-observed') return last;
  if (last.pairedRefs !== true) return blocked('anchor-unverified');
  if (last.headOid !== first.headOid || last.repositoryFullName !== first.repositoryFullName) return blocked('checkpoint-head-changed');
  return { kind: 'checkpoint-snapshot-observed', headOid: first.headOid, rollbackProtected: false,
    repositoryId: registration.repositoryId, repositoryFullName: first.repositoryFullName, cutoverAt: registration.cutoverAt, schemaVersion, selection,
    index: inventory.index, selectedRecord: inventory.selectedRecord };
}
