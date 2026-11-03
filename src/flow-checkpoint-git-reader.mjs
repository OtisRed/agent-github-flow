const oid = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);

// request is a trusted authenticated GET-only transport. URLs are constructed
// locally from validated components; API-returned URLs are never followed.
export function createCheckpointGitReader({ owner, repo, request } = {}) {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(owner ?? '') || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo ?? '')
      || repo === '.' || repo === '..' || typeof request !== 'function') throw Error('invalid-checkpoint-reader');
  const root = `https://api.github.com/repos/${owner}/${repo}/git`;
  const get = (kind, value, query = '') => {
    if (!oid(value)) throw Error('invalid-oid');
    return request(`${root}/${kind}/${value}${query}`);
  };
  return Object.freeze({
    readCommit: value => get('commits', value),
    readTree: (value, options) => {
      if (!options || options.recursive !== true || Object.keys(options).length !== 1) throw Error('recursive-read-required');
      return get('trees', value, '?recursive=1');
    },
    readBlob: value => get('blobs', value),
  });
}
