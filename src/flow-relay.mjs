import { selectCentralWakeup } from './flow-central-wakeup.mjs';

const actions = { issue_comment: new Set(['created', 'edited', 'deleted']), issues: new Set(['opened', 'closed', 'reopened']) };

// Sending is a wakeup only. The central receiver must re-read and authorize
// the underlying data. Never retry automatically after an uncertain response.
export async function relayFlowEvent({ eventName, event, source, targetRepository, token, fetchFn = fetch } = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return { kind: 'blocked' };
  if (!Object.hasOwn(actions, eventName) || !actions[eventName].has(event.action)) return { kind: 'ignored' };
  if (!event.issue || typeof event.issue !== 'object' || Array.isArray(event.issue)) return { kind: 'blocked' };
  if (Object.hasOwn(event.issue, 'pull_request')) return { kind: 'ignored' };
  if (typeof source !== 'string' || !/^[0-9a-f]{32}$/.test(source)
    || typeof token !== 'string' || token.length === 0 || token.length > 2048 || /[\r\n]/.test(token)
    || typeof fetchFn !== 'function'
    || selectCentralWakeup({ repository: targetRepository, issueNumber: event.issue.number }, [targetRepository]).kind !== 'candidate') {
    return { kind: 'blocked' };
  }
  try {
    const response = await fetchFn(`https://api.github.com/repos/${targetRepository}/dispatches`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify({ event_type: 'flow-wakeup-v1', client_payload: { source, issueNumber: event.issue.number } }),
    });
    return response?.status === 204 ? { kind: 'sent' } : { kind: 'uncertain' };
  } catch { return { kind: 'uncertain' }; }
}
