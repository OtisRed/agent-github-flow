// A wakeup is an untrusted hint, never authorization to change GitHub state.
// The caller must separately authenticate the event, load trusted configuration,
// re-read issue and Project data, establish writer ownership and verify trust.
const blocked = reason => ({ kind: 'blocked', reason });
const repositoryPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/;
const validRepository = value => typeof value === 'string' && repositoryPattern.test(value)
  && !['.', '..'].includes(value.slice(value.indexOf('/') + 1));

export function selectCentralWakeup(payload, allowedRepositories) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).length !== 2
    || !Object.hasOwn(payload, 'repository') || !Object.hasOwn(payload, 'issueNumber')
    || !validRepository(payload.repository)
    || !Number.isSafeInteger(payload.issueNumber) || payload.issueNumber < 1) {
    return blocked('invalid-wakeup');
  }
  if (!Array.isArray(allowedRepositories) || allowedRepositories.length === 0
    || allowedRepositories.some(repo => !validRepository(repo))) {
    return blocked('invalid-allowlist');
  }
  const normalized = allowedRepositories.map(repo => repo.toLowerCase());
  if (new Set(normalized).size !== normalized.length) return blocked('invalid-allowlist');
  const match = normalized.indexOf(payload.repository.toLowerCase());
  if (match === -1) return blocked('repository-not-allowed');
  return { kind: 'candidate', repository: allowedRepositories[match], issueNumber: payload.issueNumber };
}
