// Read-only evidence collection: never request secret values or print raw API output.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const namePattern = /^[A-Za-z0-9_.-]+$/;
const endpoint = (owner, repo) => `/repos/${owner}/${repo}`;

function request(args) {
  const result = spawnSync('gh', ['api', ...args], {
    encoding: 'utf8', shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

// GitHub paginated responses must have consistent total_count and no repeated
// names; otherwise a partial/unstable list is not evidence of absence.
export function completeNames(pages, key) {
  if (!Array.isArray(pages) || !pages.length) return null;
  const total = pages[0]?.total_count;
  if (!Number.isSafeInteger(total) || total < 0) return null;
  const names = [];
  for (const page of pages) {
    if (page?.total_count !== total || !Array.isArray(page[key])) return null;
    for (const entry of page[key]) {
      if (typeof entry?.name !== 'string' || !entry.name) return null;
      names.push(entry.name.toUpperCase());
    }
  }
  if (names.length !== total || new Set(names).size !== total) return null;
  return new Set(names);
}

export function collectProjectEvidence(owner, repo, get = request) {
  if (![owner, repo].every(value => typeof value === 'string' && namePattern.test(value) && value !== '.' && value !== '..')) {
    throw new Error('Invalid repository identifier');
  }
  const base = endpoint(owner, repo);
  const metadata = get([base]);
  const nodeId = metadata?.node_id;
  const identityMatches = typeof metadata?.full_name === 'string'
    && metadata.full_name.toLowerCase() === `${owner}/${repo}`.toLowerCase();
  if (!metadata || typeof nodeId !== 'string' || !nodeId || !identityMatches
    || typeof metadata.archived !== 'boolean' || typeof metadata.default_branch !== 'string'
    || typeof metadata.permissions?.admin !== 'boolean') {
    return { repository: { complete: false }, projectSecrets: { complete: false } };
  }
  const repository = { complete: true, nodeId, identityMatches, isArchived: metadata.archived,
    defaultBranch: metadata.default_branch, adminAccess: metadata.permissions.admin };
  const secretNames = completeNames(get([`${base}/environments/flow-relay/secrets?per_page=100`, '--paginate', '--slurp']), 'secrets');
  const variableNames = completeNames(get([`${base}/environments/flow-relay/variables?per_page=100`, '--paginate', '--slurp']), 'variables');
  const finalMetadata = get([base]);
  if (!finalMetadata || finalMetadata.node_id !== nodeId || finalMetadata.full_name !== metadata.full_name
    || finalMetadata.default_branch !== metadata.default_branch || finalMetadata.archived !== metadata.archived
    || finalMetadata.permissions?.admin !== metadata.permissions.admin) {
    return { repository: { complete: false }, projectSecrets: { complete: false } };
  }
  const projectSecrets = !secretNames || !variableNames ? { complete: false }
    : { complete: true, repositoryId: nodeId, environmentName: 'flow-relay',
      relayTokenExists: secretNames.has('FLOW_RELAY_TOKEN'),
      sourceAliasExists: secretNames.has('FLOW_RELAY_SOURCE'),
      targetVariableExists: variableNames.has('FLOW_RELAY_TARGET') };
  return { repository, projectSecrets };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.length !== 4) throw new Error('Expected owner and repository');
    process.stdout.write(`${JSON.stringify(collectProjectEvidence(process.argv[2], process.argv[3]))}\n`);
  } catch {
    process.stderr.write('Unable to collect onboarding evidence.\n');
    process.exitCode = 1;
  }
}
