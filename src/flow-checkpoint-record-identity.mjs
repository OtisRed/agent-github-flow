import { decodeCheckpointGitBlob } from './flow-checkpoint-git-blob.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;

// This validates only immutable blob bytes and the envelope identity. The
// checkpoint payload/schema, its public-data policy and branch provenance are
// deliberately NOT validated and remain a prerequisite for any use or write.
export function decodeCheckpointRecordIdentity(input) {
  if (!object(input) || !id(input.repositoryId) || !id(input.issueId)
      || !Number.isSafeInteger(input.number) || input.number < 1) return blocked('invalid-input');
  const schemaVersion = Object.hasOwn(input, 'schemaVersion') ? input.schemaVersion : 1;
  if (![1, 2, 3].includes(schemaVersion)) return blocked('invalid-schema-version');
  const decoded = decodeCheckpointGitBlob({ expectedOid: input.expectedOid, blob: input.blob });
  if (decoded.kind !== 'decoded-blob') return decoded;
  let record; let encoded;
  try { record = JSON.parse(decoded.content); encoded = JSON.stringify(record); }
  catch { return blocked('invalid-record-json'); }
  if (!object(record) || encoded !== decoded.content) return blocked('noncanonical-record');
  if (record.version !== schemaVersion || record.repositoryId !== input.repositoryId
      || record.number !== input.number || record.issueId !== input.issueId) return blocked('record-identity-mismatch');
  return { kind: 'record-identity-verified', record };
}
