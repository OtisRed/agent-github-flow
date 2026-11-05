import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseGitHubRemote, parseProjectArgument, assessProject, classifyProjectRead, diagnose } from '../scripts/diagnose.mjs';

function removeFixture(root) {
  const target = realpathSync(root);
  const parent = realpathSync(tmpdir());
  assert.equal(path.dirname(target).toLowerCase(), parent.toLowerCase());
  assert.ok(path.basename(target).startsWith('github-flow-test-'));
  rmSync(target, { recursive: true, force: true });
}

test('remote identities accept GitHub URLs without exposing embedded credentials', () => {
  assert.deepEqual(parseGitHubRemote('https://alice:secret@github.com/Org/Repo.git'), { owner: 'Org', repo: 'Repo' });
  assert.deepEqual(parseGitHubRemote('git@github.com:Org/Repo.git'), { owner: 'Org', repo: 'Repo' });
  assert.deepEqual(parseGitHubRemote('ssh://git@github.com/Org/Repo.git'), { owner: 'Org', repo: 'Repo' });
  assert.equal(parseGitHubRemote('https://github.com.evil.test/Org/Repo'), null);
  assert.equal(parseGitHubRemote('https://github.com/Org/Repo/extra'), null);
});

test('explicit Project identities are bounded and reject malformed input', () => {
  assert.deepEqual(parseProjectArgument('user:Owner/14'), { projectOwnerType: 'user', projectOwnerLogin: 'Owner', projectNumber: 14, statusFieldName: 'Status' });
  assert.equal(parseProjectArgument('user:Owner/0'), null);
  assert.equal(parseProjectArgument('user:Owner/14/extra'), null);
  assert.equal(parseProjectArgument('user:Owner/9007199254740992'), null);
});

test('Project assessment distinguishes missing names from absent mappings and detects enabled native link', () => {
  const p = { fields: { nodes: [{ name: 'Status', options: [{ name: 'review' }] }] }, workflows: { nodes: [{ name: 'Pull request linked to issue', enabled: true }] } };
  const result = assessProject(p, 'Status');
  assert.equal(result.valid, true);
  assert.equal(result.linkedState, true);
  assert.equal(assessProject({ ...p, workflows: { nodes: [] } }, 'Status').linkedState, null);
  assert.equal(assessProject({ ...p, workflows: { nodes: [{ name: 'Pull request linked to issue', enabled: false }] } }, 'Status').linkedState, false);
  assert.ok(result.missing.includes('smoke'));
  assert.equal(assessProject(p, 'Wrong').valid, false);
  assert.equal(assessProject(null, 'Status').valid, false);
});

test('a verified mismatch in the configured Project field is conflict; incomplete reads are unverified', () => {
  const project = { fields: { nodes: [{ name: 'Other', options: [] }], pageInfo: { hasNextPage: false } }, workflows: { nodes: [], pageInfo: { hasNextPage: false } } };
  assert.deepEqual(classifyProjectRead({ ok: true, data: {} }, project, 'Status'), { state: 'conflict', code: 'configured-single-select-absent' });
  assert.equal(classifyProjectRead({ ok: false }, project, 'Status').state, 'unverified');
  assert.equal(classifyProjectRead({ ok: true, data: { errors: [{}] } }, project, 'Status').state, 'unverified');
  assert.equal(classifyProjectRead({ ok: true, data: {} }, { ...project, fields: { ...project.fields, pageInfo: { hasNextPage: true } } }, 'Status').state, 'unverified');
  assert.equal(classifyProjectRead({ ok: true, data: {} }, { ...project, fields: { ...project.fields, pageInfo: {} } }, 'Status').state, 'unverified');
});

test('offline diagnosis inventories a real local Git repository without writing or exposing a remote secret', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'github-flow-test-'));
  try {
    const init = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    mkdirSync(path.join(root, '.github', 'workflow'), { recursive: true });
    writeFileSync(path.join(root, 'AGENTS.md'), 'local policy\n');
    writeFileSync(path.join(root, '.github', 'workflow', 'project.json'), JSON.stringify({ projectOwnerType: 'user', projectOwnerLogin: 'someone', projectNumber: 4, statusFieldName: 'Status' }));
    const remote = spawnSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://user:secret-value@github.com/someone/repo.git'], { encoding: 'utf8' });
    assert.equal(remote.status, 0, remote.stderr);
    const before = readFileSync(path.join(root, '.git', 'config'), 'utf8');
    const result = diagnose(root);
    assert.equal(result.checks.find((c) => c.id === 'repository').state, 'ok');
    assert.equal(result.checks.find((c) => c.id === 'local-project-source').state, 'ok');
    assert.equal(result.checks.find((c) => c.id === 'github-live').state, 'unverified');
    assert.equal(JSON.stringify(result).includes('secret-value'), false);
    assert.equal(readFileSync(path.join(root, '.git', 'config'), 'utf8'), before);
    const matching = diagnose(root, false, parseProjectArgument('user:SOMEONE/4'));
    assert.equal(matching.checks.find((c) => c.id === 'explicit-project').state, 'ok');
    const conflicting = diagnose(root, false, parseProjectArgument('user:someone/5'));
    assert.equal(conflicting.checks.find((c) => c.id === 'explicit-project').state, 'conflict');
    assert.equal(conflicting.inventory.projectSource.number, 4);
    const remote2 = spawnSync('git', ['-C', root, 'remote', 'add', 'upstream', 'https://github.com/other/repo.git'], { encoding: 'utf8' });
    assert.equal(remote2.status, 0, remote2.stderr);
    const ambiguous = diagnose(root);
    assert.equal(ambiguous.checks.find((c) => c.id === 'remote-identity').state, 'unverified');
    assert.equal(ambiguous.inventory.githubRepository, undefined);
  } finally { removeFixture(root); }
});

test('an explicitly supplied Project does not claim repository membership', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'github-flow-test-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
    const result = diagnose(root, false, parseProjectArgument('user:owner/14'));
    assert.equal(result.checks.find((c) => c.id === 'local-project-source').state, 'missing');
    assert.equal(result.checks.find((c) => c.id === 'explicit-project').state, 'ok');
    assert.match(result.checks.find((c) => c.id === 'explicit-project').evidence, /membership.*not verified/);
    mkdirSync(path.join(root, '.github', 'workflow'), { recursive: true });
    writeFileSync(path.join(root, '.github', 'workflow', 'project.json'), '{invalid');
    const malformed = diagnose(root, false, parseProjectArgument('user:owner/14'));
    assert.equal(malformed.checks.find((c) => c.id === 'explicit-project').state, 'unverified');
    assert.equal(malformed.inventory.projectSource, undefined);
  } finally { removeFixture(root); }
});

test('a non-repository is unverified, not reported as a missing GitHub Project', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'github-flow-test-'));
  try {
    const result = diagnose(root, true);
    assert.equal(result.checks.find((c) => c.id === 'repository').state, 'unverified');
    assert.equal(result.checks.some((c) => c.id === 'github-project' && c.state === 'missing'), false);
  } finally { removeFixture(root); }
});
