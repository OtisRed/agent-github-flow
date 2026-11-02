import { readFile, stat } from 'node:fs/promises';
import { relayFlowEvent } from './flow-relay.mjs';

try {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || (await stat(eventPath)).size > 1_000_000) throw Error('invalid-event');
  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  const verdict = await relayFlowEvent({ eventName: process.env.GITHUB_EVENT_NAME, event,
    source: process.env.FLOW_RELAY_SOURCE, targetRepository: process.env.FLOW_RELAY_TARGET, token: process.env.FLOW_RELAY_TOKEN });
  if (verdict.kind === 'sent') console.log('Flow relay: accepted by GitHub');
  else if (verdict.kind === 'ignored') console.log('Flow relay: ignored');
  else { console.error('Flow relay: blocked or uncertain'); process.exitCode = 1; }
} catch { console.error('Flow relay: unavailable'); process.exitCode = 1; }
