import { validAtomicRefTarget, validAtomicRefIdentity } from './atomic-ref-api.mjs';

if (!validAtomicRefTarget(process.env.TARGET_OWNER, process.env.TARGET_REPO)
    || !validAtomicRefIdentity(process.env.EXPECTED_REPOSITORY_ID, process.env.EXPECTED_HEAD, process.env.EXPECTED_PARENT)) {
  console.error('Invalid single-repository probe target.'); process.exit(1);
}
console.log('Single-repository probe target validated.');
