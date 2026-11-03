import { decodeCheckpointIndex } from './flow-checkpoint-index.mjs';
import { decodeCheckpointGitBlob } from './flow-checkpoint-git-blob.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
// Verify the exact Git blob returned by a caller-supplied GitHub read. The
// caller must still bind expectedOid to the right tree and commit, prove the
// complete inventory and establish branch provenance before any mutation.
export function decodeCheckpointIndexBlob(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return blocked('invalid-blob');
  const { expectedOid, repositoryId, blob } = input;
  const result = decodeCheckpointGitBlob({ expectedOid, blob });
  return result.kind === 'decoded-blob' ? decodeCheckpointIndex(result.content, repositoryId) : result;
}
