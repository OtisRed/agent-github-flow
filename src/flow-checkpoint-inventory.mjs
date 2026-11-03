const blocked = reason => ({ kind: 'blocked', reason });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.trim() === value;
const number = value => Number.isSafeInteger(value) && value > 0;

// Validates only the identity and bidirectional inventory of parsed records.
// The reader must prove that the tree listing is complete, belongs to one
// exact commit and contains all files under issues/. Neither this function nor
// its result establishes branch provenance, record contents or write safety.
export function validateCheckpointInventory(input) {
  if (!object(input) || !id(input.repositoryId)) return blocked('invalid-input');
  if (input.complete !== true) return blocked('incomplete-tree');
  const { repositoryId, index, records } = input;
  if (!object(index) || index.version !== 1 || index.repositoryId !== repositoryId
      || !Array.isArray(index.issues) || !Array.isArray(records)) return blocked('invalid-index');
  const byNumber = new Map();
  const issueIds = new Set();
  for (const issue of index.issues) {
    if (!object(issue) || !number(issue.number) || !id(issue.issueId)
        || byNumber.has(issue.number) || issueIds.has(issue.issueId)) return blocked('invalid-index-entry');
    byNumber.set(issue.number, issue.issueId);
    issueIds.add(issue.issueId);
  }
  const seen = new Set();
  for (const entry of records) {
    if (!object(entry) || typeof entry.path !== 'string' || !object(entry.value)) return blocked('invalid-record');
    const record = entry.value;
    if (record.version !== 1 || record.repositoryId !== repositoryId || !number(record.number)
        || !id(record.issueId) || entry.path !== `issues/${record.number}.json`) return blocked('invalid-record');
    if (seen.has(record.number)) return blocked('duplicate-record');
    seen.add(record.number);
    if (!byNumber.has(record.number)) return blocked('orphan-record');
    if (byNumber.get(record.number) !== record.issueId) return blocked('record-identity-mismatch');
  }
  if (seen.size !== byNumber.size) return blocked('missing-record');
  return { kind: 'valid-inventory', issueCount: seen.size };
}
