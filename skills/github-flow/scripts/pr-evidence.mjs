import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SHA = /^[a-f0-9]{40}$/i;
const ID = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const isNumber = (n) => Number.isSafeInteger(n) && n > 0;

// Mirrors VSone's standaloneRefs without importing or running repository code.
export function standaloneRefs(body) {
  if (typeof body !== 'string') return [];
  return body.split(/\r?\n/).map((line) => /^Refs #(\d+)\s*$/.exec(line.trim())).filter(Boolean).map((m) => Number(m[1])).filter(isNumber);
}

export function evaluateRefs(body, issue = null) {
  if (typeof body !== 'string' || (issue !== null && !isNumber(issue))) return { state: 'unverified', code: 'refs-input-unavailable' };
  const refs = standaloneRefs(body);
  if (!refs.length) return { state: 'missing', code: 'standalone-refs-absent', refs };
  if (refs.length !== 1) return { state: 'conflict', code: 'multiple-refs', refs };
  if (issue === null) return { state: 'unverified', code: 'expected-issue-unspecified', refs };
  if (refs[0] !== issue) return { state: 'conflict', code: 'different-issue', refs };
  return { state: 'ok', code: 'refs-match', refs };
}

export function evaluateHead({ initialHead, lastCommit, finalHead, expectedSha = null }) {
  if (![initialHead, lastCommit, finalHead].every((s) => typeof s === 'string' && SHA.test(s)) || (expectedSha !== null && (typeof expectedSha !== 'string' || !SHA.test(expectedSha)))) return { state: 'unverified', code: 'sha-unavailable-or-invalid' };
  const [start, commit, end] = [initialHead, lastCommit, finalHead].map((s) => s.toLowerCase());
  if (start !== commit || start !== end) return { state: 'conflict', code: 'head-changed-or-commit-mismatch', initialHead: start, finalHead: end };
  if (expectedSha !== null && end !== expectedSha.toLowerCase()) return { state: 'conflict', code: 'expected-sha-stale', currentHead: end, expectedSha: expectedSha.toLowerCase() };
  return { state: 'ok', code: expectedSha === null ? 'head-snapshot-consistent' : 'expected-head-current', currentHead: end };
}

function readGraphQL(query, variables) {
  const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${variables.owner}`, '-f', `name=${variables.name}`, '-F', `number=${variables.number}`];
  const result = spawnSync('gh', args, { encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1' } });
  if (result.error || result.status !== 0) return { ok: false, code: result.error?.code === 'ETIMEDOUT' ? 'timeout' : result.error?.code === 'ENOENT' ? 'tool-unavailable' : 'github-read-failed' };
  try { const data = JSON.parse(result.stdout); return data.errors?.length ? { ok: false, code: 'graphql-incomplete' } : { ok: true, data }; }
  catch { return { ok: false, code: 'invalid-response' }; }
}

export function inspectPr({ repository, pr, issue = null, expectedSha = null }, read = readGraphQL) {
  const report = { schemaVersion: 1, observedAt: new Date().toISOString(), scope: { repository, pr, issue }, checks: [], limitations: ['Refs is a textual convention, not a native GitHub issue link.', 'SHA equality is a point-in-time observation, not proof of CI, review, smoke, merge readiness, or required checks.', 'Repository-specific process and supported base branches must be checked separately.'] };
  if (typeof repository !== 'string' || !ID.test(repository) || !isNumber(pr) || (issue !== null && !isNumber(issue)) || (expectedSha !== null && (typeof expectedSha !== 'string' || !SHA.test(expectedSha)))) { report.checks.push({ id: 'input', state: 'unverified', code: 'invalid-arguments' }); return report; }
  const [owner, name] = repository.split('/');
  const vars = { owner, name, number: pr };
  const snapshotQuery = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number state isDraft baseRefName body headRefOid commits(last:1){nodes{commit{oid}}}}}}';
  const headQuery = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number headRefOid}}}';
  const first = read(snapshotQuery, vars);
  const pull = first?.data?.data?.repository?.pullRequest;
  if (!first?.ok || first.data?.errors?.length || pull?.number !== pr) { report.checks.push({ id: 'pull-request', state: 'unverified', code: first?.code || 'pr-unavailable' }); return report; }
  report.inventory = { state: pull.state, draft: pull.isDraft, base: pull.baseRefName };
  report.checks.push({ id: 'refs', ...evaluateRefs(pull.body, issue) });
  const second = read(headQuery, vars);
  const latest = second?.data?.data?.repository?.pullRequest;
  if (!second?.ok || second.data?.errors?.length || latest?.number !== pr) report.checks.push({ id: 'head-sha', state: 'unverified', code: second?.code || 'head-reread-unavailable' });
  else report.checks.push({ id: 'head-sha', ...evaluateHead({ initialHead: pull.headRefOid, lastCommit: pull.commits?.nodes?.at(-1)?.commit?.oid, finalHead: latest.headRefOid, expectedSha }) });
  return report;
}

function main(args) {
  const options = { repository: null, pr: null, issue: null, expectedSha: null };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--repository', '--pr', '--issue', '--expected-sha'].includes(key) || seen.has(key) || !args[i + 1] || args[i + 1].startsWith('--')) { process.stderr.write('Usage: node pr-evidence.mjs --repository OWNER/REPO --pr N [--issue N] [--expected-sha SHA]\n'); process.exitCode = 2; return; }
    seen.add(key); const value = args[++i];
    if (key === '--repository') options.repository = value;
    if (key === '--pr') options.pr = /^\d+$/.test(value) ? Number(value) : NaN;
    if (key === '--issue') options.issue = /^\d+$/.test(value) ? Number(value) : NaN;
    if (key === '--expected-sha') options.expectedSha = value;
  }
  const report = inspectPr(options);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.checks.some((c) => c.code === 'invalid-arguments')) process.exitCode = 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
