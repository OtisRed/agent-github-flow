import { encodeCheckpointV2 } from './flow-checkpoint-v2.mjs';
import { planCheckpointV2Commit } from './flow-checkpoint-commit-plan.mjs';
import { planPendingBranchHandoff } from './flow-checkpoint-pending-handoff.mjs';

const blocked = reason => ({ kind: 'blocked', reason });

// Pure construction, not authority to publish or mutate a Project. The caller
// must supply independently authenticated, complete and fresh observations,
// bootstrap/protection evidence and serialization. For retries it must also
// wait between two fresh observations in the same runner; the stored timestamp
// does not prove that waiting occurred or that an old request has ended.
export function planStatusReservation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.checkpoint?.schemaVersion !== 2
      || encodeCheckpointV2(input.checkpoint?.selectedRecord).kind !== 'encoded-record') return blocked('invalid-v2-snapshot');
  let projected;
  try { projected = structuredClone(input); } catch { return blocked('invalid-input'); }
  // Reuse the existing pure first-handoff evidence validation, without giving
  // its v1 projection to any writer. Only the source-status plan is accepted.
  projected.checkpoint.schemaVersion = 1;
  projected.checkpoint.selectedRecord.version = 1;
  delete projected.checkpoint.selectedRecord.reservation;
  const handoff = planPendingBranchHandoff(projected);
  if (handoff.kind !== 'status-update-planned') return blocked('handoff-not-reservable');
  const before = input.checkpoint.selectedRecord;
  if (before.reservation && (before.reservation.fromOptionId !== handoff.fromOptionId
      || before.reservation.targetOptionId !== handoff.targetOptionId)) return blocked('reservation-option-mismatch');
  const after = structuredClone(before);
  after.reservation = { reservedAt: input.reservedAt, fromOptionId: handoff.fromOptionId, targetOptionId: handoff.targetOptionId };
  const commit = planCheckpointV2Commit({ registration: input.registration, snapshot: input.checkpoint, after });
  if (commit.kind !== 'checkpoint-commit-plan') return blocked('reservation-plan-invalid');
  return { kind: 'status-reservation-planned', record: after, commit };
}
