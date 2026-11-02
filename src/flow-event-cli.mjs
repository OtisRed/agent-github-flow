import { readFile, stat } from 'node:fs/promises';
import { inspectFlowEvent } from './flow-event-preflight.mjs';

// Diagnostic only: never print the event, issue number, configuration, or a
// private repository name. A candidate does not authorize any GitHub write.
try {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || (await stat(eventPath)).size > 1_000_000) throw Error('invalid-event');
  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  let routes;
  if (process.env.FLOW_EVENT_ROUTES) {
    try { routes = JSON.parse(process.env.FLOW_EVENT_ROUTES); } catch { routes = null; }
  }
  const verdict = inspectFlowEvent({ eventName: process.env.GITHUB_EVENT_NAME, event,
    centralRepository: process.env.GITHUB_REPOSITORY, routes });
  if (verdict.kind === 'candidate') console.log('Event preflight: candidate; no writes performed');
  else if (verdict.kind === 'ignored') console.log('Event preflight: ignored');
  else { console.error('Event preflight: blocked'); process.exitCode = 1; }
} catch {
  console.error('Event preflight: unavailable'); process.exitCode = 1;
}
