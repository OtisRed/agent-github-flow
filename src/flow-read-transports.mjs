import { createProjectItemsReader } from './flow-project-rest.mjs';
import { SPLIT_PROJECT_QUERY, BRANCH_PROJECT_QUERY, SPLIT_ISSUE_QUERY, BRANCH_ISSUE_QUERY } from './flow-github-split-project.mjs';
import { HANDOFF_QUERY } from './flow-handoff-reader.mjs';
import { EPOCH_QUERY } from './flow-epoch-reader.mjs';
import { NATIVE_EPOCH_QUERY } from './flow-native-epoch-reader.mjs';
import { createCheckpointGitReader } from './flow-checkpoint-git-reader.mjs';
import { ISSUE_IDENTITY_QUERY } from './flow-project-policy-resolver.mjs';

const GRAPHQL_URL = 'https://api.github.com/graphql';
const issueQueries = new Set([SPLIT_ISSUE_QUERY, BRANCH_ISSUE_QUERY, HANDOFF_QUERY, EPOCH_QUERY, NATIVE_EPOCH_QUERY, ISSUE_IDENTITY_QUERY]);
const validToken = value => typeof value === 'string' && value.length > 0 && !/[\s\x00-\x1f\x7f]/.test(value);
const limit = 8_000_000;

// request must be a trusted fetch-compatible transport. Tokens remain scoped
// inside these closures; this is read-only plumbing, not authorization or a
// verified single-writer mechanism. Failures never expose response bodies.
export function createFlowReadTransports({ projectToken, issueToken, request = fetch } = {}) {
  if (!validToken(projectToken) || !validToken(issueToken) || typeof request !== 'function') throw Error('invalid-read-transport');
  const call = async (url, token, method, body) => {
    try {
      const response = await request(url, { method, redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2026-03-10' },
        ...(body === undefined ? {} : { body }) });
      if (!response || response.status !== 200 || typeof response.text !== 'function'
        || typeof response.headers?.get !== 'function') throw Error('invalid-response');
      const raw = await response.text();
      if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > limit) throw Error('invalid-response');
      return { data: JSON.parse(raw), link: response.headers.get('link') };
    } catch {
      throw Error('github-read-failed');
    }
  };
  const graphql = async (query, variables, token) => {
    let body;
    try { body = JSON.stringify({ query, variables }); } catch { throw Error('invalid-variables'); }
    return (await call(GRAPHQL_URL, token, 'POST', body)).data;
  };
  const projectGraphql = (query, variables) => {
    if (query !== SPLIT_PROJECT_QUERY && query !== BRANCH_PROJECT_QUERY) throw Error('unsupported-read');
    return graphql(query, variables, projectToken);
  };
  const issueGraphql = (query, variables) => {
    if (!issueQueries.has(query)) throw Error('unsupported-read');
    return graphql(query, variables, issueToken);
  };
  const listItems = createProjectItemsReader({ request: async url => {
    const result = await call(url, projectToken, 'GET');
    return { status: 200, json: async () => result.data, headers: { get: name => name === 'link' ? result.link : null } };
  } });
  const checkpointGit = ({ owner, repo } = {}) => createCheckpointGitReader({ owner, repo,
    request: async url => (await call(url, issueToken, 'GET')).data });
  return Object.freeze({ projectGraphql, issueGraphql, listItems, checkpointGit });
}
