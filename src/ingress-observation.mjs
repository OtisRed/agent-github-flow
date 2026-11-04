// Read-only integration boundary. A route must come from authenticated runtime
// configuration; the queue is a wakeup, never an authorization or a work ack.
const blocked = reason => ({kind: 'blocked', reason});
const decimal = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value)
  && BigInt(value) < 2n ** 63n;
const deliveryId = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const supported = {issues: new Set(['opened', 'edited']), issue_comment: new Set(['created', 'edited'])};

export async function observeIngressDelivery(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return blocked('invalid-input');
  const {delivery, routes, resolvePolicy, graphql, keyring} = input;
  let record, registry;
  try { record = structuredClone(delivery); registry = structuredClone(routes); }
  catch { return blocked('invalid-input'); }
  if (!record || record.kind !== 'delivery' || !deliveryId(record.deliveryId)
      || !decimal(record.installationId) || !decimal(record.repositoryId) || !decimal(record.issueNumber)
      || (record.event === 'issues' ? record.commentId !== null : !decimal(record.commentId))
      || !Array.isArray(registry) || !registry.length || typeof resolvePolicy !== 'function'
      || typeof graphql !== 'function') return blocked('invalid-input');
  if (typeof record.event !== 'string' || typeof record.action !== 'string'
      || !Object.hasOwn(supported, record.event) || !supported[record.event].has(record.action))
    return blocked('unsupported-event');
  // GitHub GraphQL Int is signed 32-bit, stricter than Number's safe range.
  if (BigInt(record.issueNumber) > 2147483647n) return blocked('issue-number-out-of-range');
  if (registry.some(route => !route || !decimal(route.installationId) || !decimal(route.repositoryId)
      || !route.registration || !route.registrationCommitment)) return blocked('invalid-registry');
  const matches = registry.filter(route => route.installationId === record.installationId
    && route.repositoryId === record.repositoryId);
  if (matches.length !== 1 || registry.filter(route => route.repositoryId === record.repositoryId).length !== 1)
    return blocked('route-mismatch');
  const route = matches[0], registration = route.registration;
  if (typeof registration.repository !== 'string' || typeof registration.source !== 'string')
    return blocked('invalid-registry');
  try {
    const result = await resolvePolicy({registration, registrationCommitment: route.registrationCommitment,
      keyring, source: registration.source,
      candidate: {kind: 'candidate', repository: registration.repository, issueNumber: Number(record.issueNumber)},
      graphql});
    return result?.kind === 'project-policy-resolved' ? {kind: 'observed'} : blocked('policy-unavailable');
  } catch { return blocked('policy-unavailable'); }
}
