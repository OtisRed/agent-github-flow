import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const expectedStates = ['decision-gate', 'needs-design', 'audit', 'spike', 'agent-ready', 'review', 'smoke', 'done'];
const run = (cmd, args, cwd) => {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1' } });
  if (result.error || result.status !== 0) return { ok: false, code: result.error?.code === 'ETIMEDOUT' ? 'timeout' : result.error?.code === 'ENOENT' ? 'tool-unavailable' : 'read-failed' };
  return { ok: true, text: result.stdout.trim() };
};
const json = (result) => {
  if (!result.ok) return result;
  try { return { ok: true, data: JSON.parse(result.text) }; }
  catch { return { ok: false, code: 'invalid-response' }; }
};
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const pathState = (p) => { try { return { status: 'present', stat: statSync(p) }; } catch (e) { return { status: e.code === 'ENOENT' ? 'missing' : 'unverified' }; } };
const check = (id, state, evidence, next) => ({ id, state, evidence, next });

export function parseGitHubRemote(value) {
  const input = value.trim();
  let owner, repo;
  const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(input);
  if (ssh) [, owner, repo] = ssh;
  else {
    try {
      const url = new URL(input);
      if (!['https:', 'ssh:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'github.com') return null;
      const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
      if (parts.length !== 2) return null;
      [owner, repo] = parts; repo = repo.replace(/\.git$/i, '');
    } catch { return null; }
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo) || !owner || !repo) return null;
  return { owner, repo };
}

export function parseProjectArgument(value) {
  const match = /^(user|organization):([A-Za-z0-9-]+)\/([1-9][0-9]*)$/.exec(value);
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number)) return null;
  return { projectOwnerType: match[1], projectOwnerLogin: match[2], projectNumber: number, statusFieldName: 'Status' };
}

export function assessProject(project, fieldName) {
  if (!project || !Array.isArray(project.fields?.nodes) || !Array.isArray(project.workflows?.nodes)) return { valid: false, code: 'incomplete-project' };
  const fields = project.fields.nodes.filter((f) => f?.name === fieldName);
  if (fields.length === 0) return { valid: false, code: 'configured-single-select-absent' };
  if (fields.length !== 1 || !Array.isArray(fields[0].options)) return { valid: false, code: 'ambiguous-field' };
  const names = fields[0].options.map((o) => o.name);
  const enabled = project.workflows.nodes.filter((w) => w.enabled === true).map((w) => w.name);
  const linked = project.workflows.nodes.filter((w) => w.name === 'Pull request linked to issue');
  return { valid: true, names, enabled, missing: expectedStates.filter((s) => !names.includes(s)), linkedState: linked.length === 1 && typeof linked[0].enabled === 'boolean' ? linked[0].enabled : null };
}

export function classifyProjectRead(response, project, fieldName) {
  if (!response?.ok || response.data?.errors?.length || !project || project.fields?.pageInfo?.hasNextPage !== false || project.workflows?.pageInfo?.hasNextPage !== false) return { state: 'unverified', code: 'incomplete-project-read' };
  const assessment = assessProject(project, fieldName);
  if (!assessment.valid) return { state: assessment.code === 'configured-single-select-absent' ? 'conflict' : 'unverified', code: assessment.code };
  return { state: 'ok', assessment };
}

function localGuidance(root, requested) {
  const found = [];
  let unreadable = false;
  const inspect = (p) => {
    const state = pathState(p);
    if (state.status === 'unverified') unreadable = true;
    if (state.status === 'present' && state.stat.isFile()) found.push(path.relative(root, p));
  };
  let current = requested;
  while (true) {
    for (const name of ['AGENTS.md', 'CLAUDE.md', 'docs.md']) {
      inspect(path.join(current, name));
    }
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current || !path.relative(root, parent).split(path.sep).every((x) => x !== '..')) break;
    current = parent;
  }
  for (const p of ['.github/copilot-instructions.md', '.agents/skills/development-workflow/SKILL.md', '.agents/skills/work-orchestration/SKILL.md', '.agents/roles/README.md']) inspect(path.join(root, p));
  return { found: [...new Set(found)], unreadable };
}

export function diagnose(requestedPath, live = false, explicitProject = null) {
  const requested = path.resolve(requestedPath);
  const report = { schemaVersion: 1, observedAt: new Date().toISOString(), scope: { requestedPath: requested, liveRequested: live }, checks: [], inventory: {}, limitations: [
    'Local presence does not prove a rule is current or deployed.',
    'Project workflow triggers, filters, target fields, and all concurrent owners are not verified by this helper.',
    'Issue/PR readiness, actual review, checks, smoke, permissions, secret values, and full board health are not evaluated.'
  ] };
  const add = (id, state, evidence, next) => report.checks.push(check(id, state, evidence, next));
  if (!isDir(requested)) { add('repository', 'unverified', 'Requested path is not an accessible directory.', 'Select an existing directory.'); return report; }
  const rootRead = run('git', ['rev-parse', '--show-toplevel'], requested);
  if (!rootRead.ok) { add('repository', 'unverified', `Git root unavailable: ${rootRead.code}.`, 'Check Git access or initialize a repository if appropriate.'); return report; }
  const root = path.resolve(rootRead.text); report.scope.repositoryRoot = root;
  if (path.relative(root, requested).split(path.sep).includes('..')) { add('repository', 'unverified', 'Requested directory is outside the resolved repository.', 'Choose an unambiguous repository path.'); return report; }
  add('repository', 'ok', 'Git root resolved locally.', 'Read the applicable repository instructions.');
  const guidance = localGuidance(root, requested);
  report.inventory.guidance = guidance.found;
  add('local-guidance', guidance.unreadable ? 'unverified' : guidance.found.length ? 'ok' : 'missing', guidance.unreadable ? 'Some instruction locations could not be inspected; inventory may be incomplete.' : guidance.found.length ? 'Instruction files found; contents and applicability require review.' : 'No supported instruction file found along the requested path.', 'Read applicable guidance; propose local instructions if needed.');
  const workflowDir = path.join(root, '.github', 'workflows');
  try {
    const dir = pathState(workflowDir);
    report.inventory.localWorkflowFiles = dir.status === 'missing' ? [] : dir.status === 'present' && dir.stat.isDirectory() ? readdirSync(workflowDir).filter((n) => /\.ya?ml$/i.test(n)).sort() : null;
  }
  catch { report.inventory.localWorkflowFiles = null; }
  add('local-workflow-files', report.inventory.localWorkflowFiles === null ? 'unverified' : report.inventory.localWorkflowFiles.length ? 'ok' : 'missing', report.inventory.localWorkflowFiles === null ? 'Local workflow directory could not be read.' : `${report.inventory.localWorkflowFiles.length} local workflow files observed; deployment and behavior not verified.`, 'Inspect relevant workflows and their owners.');
  const configPath = path.join(root, '.github', 'workflow', 'project.json');
  let projectConfig = null;
  const configState = pathState(configPath);
  if (configState.status === 'missing') add('local-project-source', 'missing', 'Supported local Project config not found; GitHub Project existence is unknown.', 'Discover any other project configuration and live Project.');
  else if (configState.status === 'unverified') add('local-project-source', 'unverified', 'Project config could not be inspected.', 'Check file access without overwriting it.');
  else {
    try {
      const c = JSON.parse(readFileSync(configPath, 'utf8'));
      if (!['user', 'organization'].includes(c.projectOwnerType) || !/^[A-Za-z0-9-]+$/.test(c.projectOwnerLogin || '') || !Number.isSafeInteger(c.projectNumber) || c.projectNumber <= 0 || typeof c.statusFieldName !== 'string' || !c.statusFieldName) throw Error();
      projectConfig = c; report.inventory.projectSource = { file: '.github/workflow/project.json', ownerType: c.projectOwnerType, owner: c.projectOwnerLogin, number: c.projectNumber, statusField: c.statusFieldName };
      add('local-project-source', 'ok', 'Supported Project identity found in an existing config; live state is not implied.', 'Use this source rather than duplicating its identity.');
    } catch { add('local-project-source', 'unverified', 'Project config is unreadable, malformed, or uses an unsupported schema.', 'Inspect the file without overwriting it.'); }
  }
  if (explicitProject) {
    const same = projectConfig && projectConfig.projectOwnerType === explicitProject.projectOwnerType
      && projectConfig.projectOwnerLogin.toLowerCase() === explicitProject.projectOwnerLogin.toLowerCase()
      && projectConfig.projectNumber === explicitProject.projectNumber;
    if (projectConfig && !same) {
      add('explicit-project', 'conflict', 'The supplied Project differs from the existing local Project config.', 'Resolve the canonical Project before a live Project read.');
      projectConfig = null;
    } else if (!projectConfig && configState.status !== 'missing') {
      add('explicit-project', 'unverified', 'The existing local Project config could not be reconciled with the supplied identity.', 'Inspect the existing config first.');
    } else if (!projectConfig) {
      projectConfig = explicitProject;
      report.inventory.projectSource = { source: 'explicit', ownerType: explicitProject.projectOwnerType, owner: explicitProject.projectOwnerLogin, number: explicitProject.projectNumber, statusField: explicitProject.statusFieldName };
      add('explicit-project', 'ok', 'A Project identity was supplied for a read; repository membership and controller enrollment are not verified.', 'Confirm the selected Project belongs to this repository.');
    } else add('explicit-project', 'ok', 'The supplied Project matches the local identity.', 'Use the configured status field.');
  }
  const remotes = run('git', ['remote'], root);
  const names = remotes.ok && remotes.text ? remotes.text.split(/\r?\n/).filter(Boolean) : [];
  report.inventory.remoteNames = names;
  let identity = null;
  if (!remotes.ok) add('remote-identity', 'unverified', `Cannot list Git remotes: ${remotes.code}.`, 'Check local Git access.');
  else if (names.length === 0) add('remote-identity', 'missing', 'No Git remotes configured locally.', 'Choose a repository destination if appropriate.');
  else if (names.length !== 1) add('remote-identity', 'unverified', 'Multiple remotes; no repository selected automatically.', 'Determine the intended remote.');
  else {
    const value = run('git', ['remote', 'get-url', names[0]], root);
    identity = value.ok ? parseGitHubRemote(value.text) : null;
    if (identity) { report.inventory.githubRepository = identity; add('remote-identity', 'ok', 'One GitHub remote identified; credentials are not printed.', 'Confirm it is the intended delivery repository.'); }
    else add('remote-identity', 'unverified', 'Remote is unreadable, unsupported, or not github.com.', 'Determine the provider and repository identity.');
  }
  if (!live) { add('github-live', 'unverified', 'Live GitHub reads were not requested.', 'Use --live when appropriate and allowed.'); return report; }
  if (!identity) { add('github-live', 'unverified', 'A unique GitHub remote is required for live reads.', 'Resolve repository identity before retrying.'); return report; }
  const api = `repos/${identity.owner}/${identity.repo}`;
  const repository = json(run('gh', ['api', api], root));
  if (!repository.ok || !repository.data?.default_branch) { add('github-live', 'unverified', `Repository metadata unavailable: ${repository.code || 'incomplete-response'}.`, 'Check network and GitHub access.'); return report; }
  report.inventory.liveRepository = { defaultBranch: repository.data.default_branch, private: repository.data.private, issuesEnabled: repository.data.has_issues };
  add('github-live', 'ok', 'Repository metadata read from GitHub; other settings require independent checks.', 'Compare with local instructions.');
  const files = json(run('gh', ['api', `${api}/contents/.github/workflows?ref=${encodeURIComponent(repository.data.default_branch)}`], root));
  if (files.ok && Array.isArray(files.data)) { report.inventory.defaultBranchWorkflowFiles = files.data.filter((f) => f.type === 'file' && /\.ya?ml$/i.test(f.name)).map((f) => f.name).sort(); add('default-branch-workflows', 'ok', 'Workflow filenames read from the default branch; active status and semantics not verified.', 'Inspect Actions, permissions, and owners.'); }
  else add('default-branch-workflows', 'unverified', `Workflow listing unavailable: ${files.code || 'unexpected-response'}.`, 'Check access; do not assume the directory is missing.');
  if (!projectConfig) { add('github-project', 'unverified', 'No unambiguous Project identity; GitHub Project was not searched.', 'Identify the canonical Project without assuming it is absent.'); return report; }
  const rootField = projectConfig.projectOwnerType === 'user' ? 'user' : 'organization';
  const query = `query($login:String!,$number:Int!){ ${rootField}(login:$login){ projectV2(number:$number){ fields(first:100){ nodes{ ... on ProjectV2SingleSelectField { name options { name } } } pageInfo{hasNextPage} } workflows(first:100){ nodes{ name enabled } pageInfo{hasNextPage} } } } }`;
  const project = json(run('gh', ['api', 'graphql', '-f', `query=${query}`, '-f', `login=${projectConfig.projectOwnerLogin}`, '-F', `number=${projectConfig.projectNumber}`], root));
  const p = project.ok ? project.data?.data?.[rootField]?.projectV2 : null;
  const verdict = classifyProjectRead(project, p, projectConfig.statusFieldName);
  if (verdict.state !== 'ok') {
    const evidence = verdict.state === 'conflict' ? 'The configured Status field is absent or is not a single-select field in the completely read Project.' : 'Project fields or complete workflows are unavailable or ambiguous.';
    add('github-project', verdict.state, evidence, 'Compare the authoritative local config with the Project; do not change either automatically.');
    return report;
  }
  const assessment = verdict.assessment;
  report.inventory.liveProject = { statusOptions: assessment.names, enabledWorkflows: assessment.enabled };
  add('github-project', 'ok', 'Configured Project status options and enabled workflow names read; filters and targets not checked.', 'Inspect workflow details and local state mapping.');
  add('target-status-names', assessment.missing.length ? 'unverified' : 'ok', assessment.missing.length ? `Target names not all present: ${assessment.missing.join(', ')}. A local mapping may exist.` : 'All target status names are present; semantics not proved.', 'Verify mappings and meaning before proposing changes.');
  const linkEvidence = assessment.linkedState === true ? 'Native PR-linked-to-issue workflow is enabled; its target and possible competing owner require inspection.' : assessment.linkedState === false ? 'Native PR-linked-to-issue workflow is disabled.' : 'Native PR-linked-to-issue workflow was not uniquely identified.';
  add('native-link-workflow', assessment.linkedState === false ? 'ok' : 'unverified', linkEvidence, 'Check target, triggers, and transition ownership.');
  return report;
}

function main(args) {
  let repo = process.cwd(), live = false, project = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--live') live = true;
    else if (args[i] === '--repo' && args[i + 1] && !args[i + 1].startsWith('--')) repo = args[++i];
    else if (args[i] === '--project' && args[i + 1] && !project) {
      project = parseProjectArgument(args[++i]);
      if (!project) { process.stderr.write('Invalid Project identity; expected user:OWNER/NUMBER or organization:OWNER/NUMBER.\n'); process.exitCode = 2; return; }
    }
    else { process.stderr.write('Usage: node diagnose.mjs [--repo <path>] [--live] [--project user:OWNER/NUMBER|organization:OWNER/NUMBER]\n'); process.exitCode = 2; return; }
  }
  process.stdout.write(JSON.stringify(diagnose(repo, live, project), null, 2) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
