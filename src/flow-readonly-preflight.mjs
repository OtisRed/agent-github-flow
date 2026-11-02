import { runFlowCycle } from './flow-cycle.mjs';
import { createFlowSnapshotReader } from './flow-snapshot.mjs';
import { SPLIT_PROJECT_QUERY, SPLIT_ISSUE_QUERY } from './flow-github-split-project.mjs';
import { HANDOFF_QUERY } from './flow-handoff-reader.mjs';
import { EPOCH_QUERY } from './flow-epoch-reader.mjs';
import { NATIVE_EPOCH_QUERY } from './flow-native-epoch-reader.mjs';

const blocked = reason => ({ kind: 'blocked', reason, steps: [] });
const issueQueries = new Set([SPLIT_ISSUE_QUERY, HANDOFF_QUERY, EPOCH_QUERY, NATIVE_EPOCH_QUERY]);
const reserved = ['graphql', 'writeStep', 'trusted', 'singleWriterVerified', 'projectSourceVerified', 'singleCardVerified'];

// Bounded composition for diagnostics only. Caller-provided transports must
// themselves be trusted read-only implementations; a callback can otherwise
// perform arbitrary side effects. This layer never grants trust, exposes a
// writer, or treats a successful read as authorization.
export async function runReadOnlyFlowPreflight(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !['handoff', 'reentry'].includes(input.mode)
    || typeof input.projectGraphql !== 'function' || typeof input.issueGraphql !== 'function'
    || typeof input.listItems !== 'function' || reserved.some(key => Object.hasOwn(input, key))) return blocked('invalid-input');
  const projectGraphql = (query, variables) => {
    if (query !== SPLIT_PROJECT_QUERY) throw Error('unsupported-read');
    return input.projectGraphql(query, variables);
  };
  const issueGraphql = (query, variables) => {
    if (!issueQueries.has(query)) throw Error('unsupported-read');
    return input.issueGraphql(query, variables);
  };
  const readSnapshot = createFlowSnapshotReader({ ...input, projectGraphql, issueGraphql });
  return runFlowCycle({ mode: input.mode, readSnapshot, maxSteps: 1,
    writeStep: async () => { throw Error('read-only-preflight'); } });
}
