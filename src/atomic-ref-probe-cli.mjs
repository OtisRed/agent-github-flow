import { appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createAtomicRefApiTransport } from './atomic-ref-api.mjs';
import { runAtomicRefProbe } from './atomic-ref-probe.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main' || !process.env.GITHUB_OUTPUT) {
  console.error('Probe configuration invalid.'); process.exit(1);
}
let transport;
try {
  transport = createAtomicRefApiTransport({ owner: process.env.TARGET_OWNER, repo: process.env.TARGET_REPO,
    expectedSlug: process.env.EXPECTED_APP_SLUG, actualSlug: process.env.ACTUAL_APP_SLUG, token: process.env.GH_TOKEN,
    expectedRepositoryId: process.env.EXPECTED_REPOSITORY_ID, expectedHead: process.env.EXPECTED_HEAD, expectedParent: process.env.EXPECTED_PARENT });
} catch { console.error('Probe configuration invalid.'); process.exit(1); }
const suffix = randomBytes(10).toString('hex');
console.log(`Temporary ref suffix: ${suffix}.`);
const result = await runAtomicRefProbe({ transport, suffix });
if (result.kind !== 'complete') {
  console.error(`Probe stopped: ${result.reason}${result.suffix ? `; temporary ref suffix ${result.suffix}` : ''}.`);
  process.exit(1);
}
appendFileSync(process.env.GITHUB_OUTPUT, `positive=${result.positive}\nnegative=${result.negative}\n`, { encoding: 'utf8' });
console.log('Positive ref-pair probe and conditional cleanup completed; see the separate negative-result step.');
