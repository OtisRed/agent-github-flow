import { selectCentralWakeup } from './flow-central-wakeup.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const nativeActions = {
  issue_comment: new Set(['created', 'edited', 'deleted']),
  issues: new Set(['opened', 'closed', 'reopened']),
};

// This is only a wakeup candidate. Neither the event nor its payload proves
// author trust, latest state, Project binding, ownership, or permission to write.
export function inspectFlowEvent({ eventName, event, centralRepository, routes, selectedRepository } = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return blocked('invalid-event');
  if (!event.repository || typeof event.repository.full_name !== 'string' || typeof centralRepository !== 'string'
    || event.repository.full_name.toLowerCase() !== centralRepository.toLowerCase()) return blocked('invalid-event');
  if (eventName === 'repository_dispatch') {
    if (event.action !== 'flow-wakeup-v1') return { kind: 'ignored' };
    const payload = event.client_payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).length !== 2 || !Object.hasOwn(payload, 'source')
      || !Object.hasOwn(payload, 'issueNumber') || typeof payload.source !== 'string'
      || !/^[0-9a-f]{32}$/.test(payload.source)
      || !Number.isSafeInteger(payload.issueNumber) || payload.issueNumber < 1) return blocked('invalid-wakeup');
    // An intentionally empty registry is [], while a missing or malformed
    // registry must never be silently ignored when an independent route exists.
    if (!Array.isArray(routes) || (selectedRepository !== undefined && typeof selectedRepository !== 'string')) return blocked('invalid-routes');
    const allRoutes = selectedRepository ? [...routes, { source: payload.source, repository: selectedRepository }] : routes;
    if (allRoutes.length === 0 || allRoutes.length > 1000
      || allRoutes.some(route => !route || typeof route !== 'object' || Array.isArray(route)
        || Object.keys(route).length !== 2 || !Object.hasOwn(route, 'source')
        || !Object.hasOwn(route, 'repository') || typeof route.source !== 'string'
        || !/^[0-9a-f]{32}$/.test(route.source))
      || new Set(allRoutes.map(route => route.source)).size !== allRoutes.length) return blocked('invalid-routes');
    const match = allRoutes.find(route => route.source === payload.source);
    if (!match) return blocked('source-not-allowed');
    return selectCentralWakeup({ repository: match.repository, issueNumber: payload.issueNumber }, allRoutes.map(route => route.repository));
  }
  if (!Object.hasOwn(nativeActions, eventName) || !nativeActions[eventName].has(event.action)) return { kind: 'ignored' };
  if (!event.issue || typeof event.issue !== 'object' || Array.isArray(event.issue)) return blocked('invalid-event');
  if (Object.hasOwn(event.issue, 'pull_request')) return { kind: 'ignored' };
  return selectCentralWakeup({ repository: event.repository.full_name, issueNumber: event.issue.number }, [centralRepository]);
}
