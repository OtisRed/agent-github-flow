import {lstatSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';

export const profileFile = 'agf-deployment.json';
export const fullSha = /^[0-9a-f]{40}$/;

function parse(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > 16384) throw Error('Expected a small regular profile file.');
  const data = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (data?.version !== 1) throw Error('Unsupported deployment profile version.');
  const clean = {version: 1};
  for (const branch of ['smoke', 'main']) {
    const target = data[branch];
    if (!['local', 'server'].includes(target?.location)) throw Error('Expected local or server location.');
    for (const field of ['start', 'verify']) {
      if (typeof target[field] !== 'string' || !target[field].trim()) throw Error('Missing start or verification instructions.');
    }
    clean[branch] = {location: target.location, start: target.start, verify: target.verify};
  }
  if (clean.smoke.location === 'server' && clean.main.location === 'local') throw Error('Unsupported deployment pair.');
  if (!isDeepStrictEqual(data, clean)) throw Error('Unexpected deployment fields.');
  return clean;
}

export function profileAt(root) {
  try {
    const declaration = parse(join(root, profileFile));
    return {state: 'ok', pair: declaration.smoke.location + '/' + declaration.main.location, declaration};
  } catch (e) {
    return {state: e.code === 'ENOENT' ? 'missing' : 'unverified'};
  }
}

export function declare(repo, source, apply) {
  const root = execFileSync('git', ['-C', resolve(repo), 'rev-parse', '--show-toplevel'], {encoding:'utf8'}).trim();
  const wanted = parse(source);
  const current = profileAt(root);
  if (current.state === 'ok' && isDeepStrictEqual(wanted, current.declaration)) return 'unchanged';
  if (current.state !== 'missing') throw Error('Existing deployment declaration differs or is unreadable; reconcile in review.');
  if (!apply) return 'would-create';
  writeFileSync(join(root, profileFile), JSON.stringify(wanted, null, 2) + '\n', {flag:'wx'});
  return 'created';
}

export function compareVersion(expected, observed) {
  if (observed === 'stopped') return 'stopped';
  if (!fullSha.test(expected ?? '') || !fullSha.test(observed ?? '')) return 'unverified';
  return observed === expected ? 'match' : 'mismatch';
}
