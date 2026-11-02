import { FLOW_STATUSES } from './flow.mjs';
import { isFlowMarker } from './flow-recovery.mjs';

const epochValid = epoch => epoch && typeof epoch === 'object' && !Array.isArray(epoch)
  && Object.keys(epoch).length === 2 && Object.hasOwn(epoch, 'kind') && Object.hasOwn(epoch, 'anchor')
  && epoch.kind === 'reopened' && typeof epoch.anchor === 'string' && !!epoch.anchor;

export function isReentryWitness(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 6
    && ['version', 'kind', 'phase', 'epoch', 'previous', 'fromStatus'].every(key => Object.hasOwn(value, key))
    && value.version === 2 && value.kind === 'reentry' && ['pending', 'ready'].includes(value.phase)
    && epochValid(value.epoch) && (value.previous === null || (isFlowMarker(value.previous) && value.previous.phase === 'committed'))
    && FLOW_STATUSES.includes(value.fromStatus);
}
