const validOid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const validNames = names => Array.isArray(names) && names.length === 2
  && /^refs\/heads\/probe\/agf-atomic-[a-f0-9]{20}\/a$/.test(names[0]) && names[1] === `${names[0].slice(0, -1)}b`;
const initialQuery = `query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){id isPrivate nameWithOwner defaultBranchRef{name target{... on Commit{oid parents(first:1){nodes{oid}}}}}}}`;
const refsQuery = `query($owner:String!,$repo:String!,$a:String!,$b:String!){repository(owner:$owner,name:$repo){id a:ref(qualifiedName:$a){target{oid}} b:ref(qualifiedName:$b){target{oid}}}}`;
const updateQuery = `mutation($input:UpdateRefsInput!){updateRefs(input:$input){__typename}}`;
export function validAtomicRefTarget(owner, repo) {
  return typeof owner === 'string' && typeof repo === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(owner)
    && /^[A-Za-z0-9_.-]{1,100}$/.test(repo) && !['.', '..'].includes(repo);
}
export function validAtomicRefIdentity(repositoryId, head, parent) {
  return typeof repositoryId === 'string' && /^[A-Za-z0-9_+/=-]{1,256}$/.test(repositoryId)
    && validOid(head) && validOid(parent) && head !== parent && head !== '0'.repeat(40) && parent !== '0'.repeat(40);
}

// Trusted fetch is the only sink for the token; fixed GitHub endpoints,
// no redirects, no logging of responses or private configuration.
export function createAtomicRefApiTransport({ owner, repo, expectedSlug, actualSlug, expectedRepositoryId, expectedHead, expectedParent,
  token, request = fetch } = {}) {
  if (!validAtomicRefTarget(owner, repo) || !/^[a-z0-9-]{1,100}$/.test(expectedSlug ?? '') || actualSlug !== expectedSlug
      || !validAtomicRefIdentity(expectedRepositoryId, expectedHead, expectedParent)
      || typeof token !== 'string' || !token || /[\s\x00-\x1f\x7f]/.test(token) || typeof request !== 'function') {
    throw Error('invalid-probe-configuration');
  }
  const call = async (endpoint, payload) => {
    try {
      if (!['graphql', 'installation/repositories'].includes(endpoint)) return { kind: 'unknown' };
      const response = await request(`https://api.github.com/${endpoint}`, { method: payload ? 'POST' : 'GET',
        redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2026-03-10' },
        ...(payload ? { body: JSON.stringify(payload) } : {}) });
      const raw = await response.text();
      if (Buffer.byteLength(raw, 'utf8') > 2_000_000) return { kind: 'unknown' };
      const data = JSON.parse(raw);
      if (response.status === 200 && !data.errors?.length) return { kind: 'ok', data };
      if (response.status === 200 && Array.isArray(data.errors) && data.errors.length) return { kind: 'rejected', errors: data.errors };
      return { kind: 'unknown' };
    } catch { return { kind: 'unknown' }; }
  };
  const query = (text, variables) => call('graphql', { query: text, variables });
  let repositoryId;
  return Object.freeze({
    initial: async () => {
      const installation = await call('installation/repositories'); const selected = installation.data?.repositories;
      if (installation.kind !== 'ok' || installation.data.total_count !== 1 || !Array.isArray(selected) || selected.length !== 1
          || selected[0].full_name !== `${owner}/${repo}` || selected[0].private !== true || selected[0].node_id !== expectedRepositoryId) {
        throw Error('scope');
      }
      const result = await query(initialQuery, { owner, repo }); const data = result.data?.data?.repository;
      if (result.kind !== 'ok' || data?.id !== expectedRepositoryId || data.nameWithOwner !== selected[0].full_name
          || data.defaultBranchRef?.target?.oid !== expectedHead
          || data.defaultBranchRef?.target?.parents?.nodes?.[0]?.oid !== expectedParent) throw Error('identity');
      repositoryId = data.id;
      return { repositoryId, private: data.isPrivate, scopeVerified: true, appVerified: true, defaultBranch: data.defaultBranchRef?.name,
        oldOid: data.defaultBranchRef?.target?.parents?.nodes?.[0]?.oid, newOid: data.defaultBranchRef?.target?.oid };
    },
    refs: async input => {
      if (input.repositoryId !== repositoryId || !validNames(input.names)) throw Error('invalid-input');
      const result = await query(refsQuery, { owner, repo, a: input.names[0], b: input.names[1] });
      const data = result.data?.data?.repository;
      if (result.kind !== 'ok' || data?.id !== repositoryId) throw Error('read-failed');
      const a = data.a === null ? null : data.a?.target?.oid; const b = data.b === null ? null : data.b?.target?.oid;
      if ((a !== null && !validOid(a)) || (b !== null && !validOid(b))) throw Error('read-failed');
      return [a, b];
    },
    update: async input => {
      const updates = input.refUpdates;
      if (input.repositoryId !== repositoryId || !Array.isArray(updates) || updates.length !== 2
          || !validNames(updates.map(item => item.name))
          || updates.some(item => item.force !== false || !validOid(item.beforeOid) || !validOid(item.afterOid))) throw Error('invalid-input');
      const current = await query(initialQuery, { owner, repo }); const currentRepo = current.data?.data?.repository;
      if (current.kind !== 'ok' || currentRepo?.id !== expectedRepositoryId || currentRepo.isPrivate !== true
          || currentRepo.nameWithOwner !== `${owner}/${repo}` || currentRepo.defaultBranchRef?.name !== 'main'
          || currentRepo.defaultBranchRef?.target?.oid !== expectedHead
          || currentRepo.defaultBranchRef?.target?.parents?.nodes?.[0]?.oid !== expectedParent) return { kind: 'unknown' };
      const result = await query(updateQuery, { input });
      if (result.kind === 'ok' && result.data?.data?.updateRefs?.__typename === 'UpdateRefsPayload') return { kind: 'ok' };
      if (result.kind !== 'rejected') return { kind: 'unknown' };
      const target = updates[1];
      const staleConfirmed = result.errors.some(error => {
        const message = typeof error?.message === 'string' ? error.message : '';
        return message.includes(target.name) && message.includes(target.beforeOid) && message.includes(updates[0].beforeOid)
          && /expected|expecting/i.test(message) && /actual|current|is at|found|but/i.test(message);
      });
      return { kind: 'rejected', staleConfirmed };
    },
  });
}
