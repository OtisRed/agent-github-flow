const blocked = reason => ({ kind: 'blocked', reason });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
const keysExactly = (value, keys) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const MAX_ISSUES = 10000;
const MAX_BYTES = 1024 * 1024;

// The index is one canonical JSON line. Canonical re-encoding makes duplicate
// keys, extensions and alternative encodings unambiguously invalid. The index
// alone cannot prove record existence, provenance or an unrolled-back branch.
export function encodeCheckpointIndex(index) {
  if (!object(index) || !keysExactly(index, ['version', 'repositoryId', 'issues'])
      || index.version !== 1 || !id(index.repositoryId) || !Array.isArray(index.issues)
      || index.issues.length > MAX_ISSUES) return blocked('invalid-index');
  let previous = 0;
  const ids = new Set();
  const issues = [];
  for (const issue of index.issues) {
    if (!object(issue) || !keysExactly(issue, ['number', 'issueId'])
        || !Number.isSafeInteger(issue.number) || issue.number <= previous
        || !id(issue.issueId) || ids.has(issue.issueId)) return blocked('invalid-index-entry');
    previous = issue.number;
    ids.add(issue.issueId);
    issues.push({ number: issue.number, issueId: issue.issueId });
  }
  const content = JSON.stringify({ version: 1, repositoryId: index.repositoryId, issues });
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) return blocked('index-too-large');
  return { kind: 'encoded-index', content };
}

export function decodeCheckpointIndex(content, repositoryId) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_BYTES || !id(repositoryId)) {
    return blocked('invalid-input');
  }
  let index;
  try { index = JSON.parse(content); } catch { return blocked('invalid-json'); }
  const encoded = encodeCheckpointIndex(index);
  if (encoded.kind !== 'encoded-index') return encoded;
  if (encoded.content !== content) return blocked('noncanonical-index');
  if (index.repositoryId !== repositoryId) return blocked('repository-mismatch');
  return { kind: 'decoded-index', index };
}
