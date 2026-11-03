// Restricted staging CLI: reads the relay token into memory and passes it to
// gh over stdin; it never prints the token, API bodies or child stderr.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { completeNames } from './relay-onboarding-observe.mjs';
import { stageNextRelayCredential } from './relay-rotation.mjs';

const gh = 'C:\\Program Files\\GitHub CLI\\gh.exe';
const git = 'C:\\Program Files\\Git\\cmd\\git.exe';
const [owner, repo, repositoryId, head, workflowBlob, workflowInventoryDigest] = process.argv.slice(2);
const safePart = value => typeof value === 'string' && /^[A-Za-z0-9_.-]+$/.test(value) && value !== '.' && value !== '..';
if (process.argv.length !== 8 || !safePart(owner) || !safePart(repo)
  || typeof repositoryId !== 'string' || !/^[A-Za-z0-9_=-]{1,128}$/.test(repositoryId)
  || !/^[a-f0-9]{40}$/.test(head ?? '') || !/^[a-f0-9]{40}$/.test(workflowBlob ?? '')
  || !/^[a-f0-9]{64}$/.test(workflowInventoryDigest ?? '')) {
  process.stderr.write('Rotation: invalid arguments.\n'); process.exit(1);
}
const base = `/repos/${owner}/${repo}`;
const cleanEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) {
  if (/^(GIT_TRACE|GCM_TRACE|GH_DEBUG)/i.test(key)) delete cleanEnv[key];
}
const run = (file, args, input, env = cleanEnv) => spawnSync(file, args, {
  input, encoding: 'utf8', env, windowsHide: true, shell: false,
  timeout: 30000, maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
});
function api(path, paginated = false) {
  const args = ['api', path];
  if (paginated) args.push('--paginate', '--slurp');
  const response = run(gh, args);
  if (response.error || response.status !== 0) throw new Error('api-unconfirmed');
  return JSON.parse(response.stdout);
}
function names(path, key) {
  const result = completeNames(api(path, true), key);
  if (!result) throw new Error('list-incomplete');
  return result;
}
async function observe() {
  const meta = api(base);
  const branch = api(`${base}/branches/main`);
  const protection = api(`${base}/branches/main/protection`);
  const environment = api(`${base}/environments/flow-relay`);
  const policies = api(`${base}/environments/flow-relay/deployment-branch-policies?per_page=100`, true);
  const policyNames = completeNames(policies, 'branch_policies');
  if (!policyNames || policies.some(page => page.branch_policies.some(item => item.type !== 'branch'))) throw new Error('policy-incomplete');
  const envSecrets = names(`${base}/environments/flow-relay/secrets?per_page=100`, 'secrets');
  const repoSecrets = names(`${base}/actions/secrets?per_page=100`, 'secrets');
  const target = api(`${base}/environments/flow-relay/variables/FLOW_RELAY_TARGET`);
  const caller = api(`${base}/contents/.github/workflows/agent-flow-relay.yml?ref=${head}`);
  const commit = api(`${base}/git/commits/${head}`);
  if (!/^[a-f0-9]{40}$/.test(commit.tree?.sha ?? '')) throw new Error('tree-unconfirmed');
  const tree = api(`${base}/git/trees/${commit.tree.sha}?recursive=1`);
  if (tree.truncated !== false || !Array.isArray(tree.tree)) throw new Error('tree-incomplete');
  const workflows = tree.tree.filter(item => /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(item.path));
  if (!workflows.length || workflows.some(item => item.type !== 'blob' || !['100644', '100755'].includes(item.mode)
    || !/^[a-f0-9]{40}$/.test(item.sha))) throw new Error('workflow-incomplete');
  workflows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (new Set(workflows.map(item => item.path)).size !== workflows.length) throw new Error('workflow-ambiguous');
  const digest = createHash('sha256').update(workflows.map(item => `${item.path}\0${item.sha}\n`).join('')).digest('hex');
  const finalMeta = api(base);
  const finalBranch = api(`${base}/branches/main`);
  const identityMatches = typeof meta.full_name === 'string' && meta.full_name.toLowerCase() === `${owner}/${repo}`.toLowerCase();
  if (meta.node_id !== finalMeta.node_id || meta.full_name !== finalMeta.full_name || meta.default_branch !== finalMeta.default_branch
    || meta.archived !== finalMeta.archived || meta.permissions?.admin !== finalMeta.permissions?.admin
    || branch.commit?.sha !== finalBranch.commit?.sha) throw new Error('identity-changed');
  return {
    repository: { complete: true, nodeId: meta.node_id, identityMatches, archived: meta.archived,
      admin: meta.permissions?.admin, defaultBranch: meta.default_branch },
    branch: { complete: true, name: branch.name, head: branch.commit?.sha },
    protection: { complete: true, adminEnforced: protection.enforce_admins?.enabled,
      prRequired: !!protection.required_pull_request_reviews,
      approvals: protection.required_pull_request_reviews?.required_approving_review_count,
      codeownerRequired: protection.required_pull_request_reviews?.require_code_owner_reviews,
      lastPushApproval: protection.required_pull_request_reviews?.require_last_push_approval,
      allowForcePush: protection.allow_force_pushes?.enabled, allowDeletion: protection.allow_deletions?.enabled },
    environment: { complete: true, exists: environment.name === 'flow-relay',
      customBranchPolicies: environment.deployment_branch_policy?.custom_branch_policies },
    branchPolicies: { complete: true, onlyMain: policyNames.size === 1 && policyNames.has('MAIN') },
    secrets: { complete: true, sourcePresent: envSecrets.has('FLOW_RELAY_SOURCE'), activePresent: envSecrets.has('FLOW_RELAY_TOKEN'),
      nextInEnvironment: envSecrets.has('FLOW_RELAY_TOKEN_NEXT'), nextInRepository: repoSecrets.has('FLOW_RELAY_TOKEN_NEXT') },
    variables: { complete: true, targetMatches: typeof target.value === 'string' && target.value.toLowerCase() === 'otisred/agent-github-flow' },
    caller: { complete: true, blob: caller.sha },
    workflowInventory: { complete: true, head, digest },
  };
}
async function readCredential() {
  const credentialEnv = { ...cleanEnv, GCM_CREDENTIAL_STORE: 'wincredman', GCM_PROVIDER: 'generic',
    GCM_INTERACTIVE: 'never', GCM_NAMESPACE: 'agent-github-flow', GCM_TRACE: '0', GCM_TRACE_SECRETS: '0' };
  const response = run(git, ['credential-manager', 'get'],
    'protocol=https\nhost=agent-github-flow-relay.invalid\nusername=agent-github-flow-relay\n\n', credentialEnv);
  if (response.error || response.status !== 0) throw new Error('credential-unconfirmed');
  const lines = response.stdout.split(/\r?\n/);
  const users = lines.filter(line => line.startsWith('username='));
  const values = lines.filter(line => line.startsWith('password='));
  if (users.length !== 1 || users[0] !== 'username=agent-github-flow-relay' || values.length !== 1) throw new Error('credential-unconfirmed');
  return values[0].slice('password='.length);
}
async function writeCredential(credential) {
  const response = run(gh, ['secret', 'set', 'FLOW_RELAY_TOKEN_NEXT', '--repo', `${owner}/${repo}`, '--env', 'flow-relay'], credential);
  return !response.error && response.status === 0;
}
// The HEAD, blob and inventory digest are a separately reviewed receipt. This
// process verifies equality, not the authenticity or quality of that review.
const policy = { repositoryId, head, workflowBlob, workflowInventoryDigest };
const result = await stageNextRelayCredential({ policy, observe, readCredential, writeCredential });
process.stdout.write(`Rotation: ${result.state}.\n`);
if (result.state !== 'staged-unverified') process.exitCode = 1;
