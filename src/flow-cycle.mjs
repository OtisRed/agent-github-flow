import { isDeepStrictEqual } from 'node:util';
import { runBootstrapStep } from './flow-bootstrap-runner.mjs';
import { runTransitionStep } from './flow-transition-runner.mjs';
import { runReentryStep } from './flow-reentry-runner.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const handoffRoute = witness => {
  if (witness?.kind === 'reentry' && witness.phase !== 'ready') return 'reentry-required';
  if (witness === null || witness?.kind === 'bootstrap' || witness?.kind === 'reentry') return 'bootstrap';
  if (witness?.version === 1) return 'transition';
  return null;
};

// Bounded coordinator for one issue. Snapshot and writer callbacks are still
// responsible for verified identity, trust and cross-trigger serialization.
// Never retries uncertain writes or supplies missing authorization flags.
export async function runFlowCycle({ mode, readSnapshot, writeStep, maxSteps = 8 }) {
  if (!['handoff', 'reentry'].includes(mode) || typeof readSnapshot !== 'function' || typeof writeStep !== 'function'
    || !Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 10) return blocked('invalid-input');
  const steps = [];
  for (let count = 0; count < maxSteps; count += 1) {
    let a, b;
    try { a = await readSnapshot(); b = await readSnapshot(); } catch { return { ...blocked('read-failed'), steps }; }
    if (!isDeepStrictEqual(a, b)) return { ...blocked('snapshot-changed'), steps };
    if (a?.kind === 'awaiting-handoff') return { kind: 'complete', outcome: 'awaiting-handoff', steps };
    if (a?.kind !== 'snapshot') return { ...blocked('snapshot-unavailable'), steps };
    const route = mode === 'reentry' ? 'reentry' : handoffRoute(a.witness);
    if (!route) return { ...blocked('invalid-checkpoint'), steps };
    if (route === 'reentry-required') return { ...blocked('reentry-required'), steps };
    const run = route === 'bootstrap' ? runBootstrapStep : route === 'transition' ? runTransitionStep : runReentryStep;
    const result = await run({ readSnapshot, writeStep: (snapshot, plan) => writeStep(snapshot, plan, route) });
    if (result.kind === 'step-applied') { steps.push(result.step); continue; }
    if (['bootstrap-complete', 'unchanged', 'already-reentered', 'awaiting-handoff', 'awaiting-fresh-handoff'].includes(result.kind)) {
      return { kind: 'complete', outcome: result.kind, steps };
    }
    return { ...result, steps };
  }
  return { ...blocked('step-limit'), steps };
}
