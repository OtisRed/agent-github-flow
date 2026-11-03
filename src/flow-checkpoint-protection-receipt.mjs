import { isDeepStrictEqual } from 'node:util';
import { auditCheckpointProtection } from './flow-checkpoint-protection-audit.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && [new Date(value).toISOString(), new Date(value).toISOString().replace('.000Z', 'Z')].includes(value);
const fields = ['id', 'target', 'source_type', 'source', 'enforcement', 'conditions', 'rules', 'updated_at'];
const repoFields = ['node_id', 'full_name', 'private', 'fork', 'default_branch'];
const select = (value, keys) => Object.fromEntries(keys.map(key => [key, value?.[key]]));
const profile = input => ({
  repositoryData: select(input.repositoryData, repoFields),
  updateRuleset: select(input.updateRuleset, fields),
  historyRuleset: select(input.historyRuleset, fields),
  effective: structuredClone(input.effective)
});
const timestampsAvailable = value => iso(value.updateRuleset?.updated_at) && iso(value.historyRuleset?.updated_at);

// Pure data model only. input must come from a complete, fresh, independently
// authenticated owner audit; store the resulting private receipt in a trusted
// configuration channel. This function performs no GitHub calls or writes.
export function createOwnerProtectionReceipt({ auditInput, observedAt, expiresAt } = {}) {
  if (!iso(observedAt) || !iso(expiresAt) || Date.parse(expiresAt) <= Date.parse(observedAt)) return blocked('invalid-receipt-period');
  const audit = auditCheckpointProtection(auditInput);
  if (audit.kind !== 'checkpoint-protection-observed') return blocked('owner-audit-unavailable');
  if (!timestampsAvailable(auditInput)) return blocked('ruleset-timestamps-unavailable');
  return { kind: 'owner-protection-receipt', version: 1, observedAt, expiresAt,
    repositoryId: audit.repositoryId, appId: audit.appId, updateRulesetId: audit.updateRulesetId,
    historyRulesetId: audit.historyRulesetId, profile: structuredClone(profile(auditInput)) };
}

// receipt, registration, clock, and both complete App observations must be
// independently trusted by the caller. A match is only a visible-drift
// observation, never evidence of current hidden bypass actors or write authority.
export function compareVisibleProtection({ receipt, registration, observations, now, maxAgeMs } = {}) {
  if (!receipt || receipt.kind !== 'owner-protection-receipt' || receipt.version !== 1
      || !iso(receipt.observedAt) || !iso(receipt.expiresAt) || !iso(now)
      || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0
      || Date.parse(receipt.expiresAt) <= Date.parse(receipt.observedAt)
      || Date.parse(receipt.expiresAt) - Date.parse(receipt.observedAt) > maxAgeMs
      || Date.parse(now) < Date.parse(receipt.observedAt) || Date.parse(now) >= Date.parse(receipt.expiresAt)) return blocked('receipt-expired-or-invalid');
  if (!registration || registration.repositoryId !== receipt.repositoryId || registration.appId !== receipt.appId
      || registration.updateRulesetId !== receipt.updateRulesetId || registration.historyRulesetId !== receipt.historyRulesetId
      || !Array.isArray(observations) || observations.length !== 2) return blocked('registration-mismatch');
  try {
    if (!timestampsAvailable(observations[0]) || !timestampsAvailable(observations[1]) || !timestampsAvailable(receipt.profile)) return blocked('ruleset-timestamps-unavailable');
    const first = profile(observations[0]); const second = profile(observations[1]);
    if (!isDeepStrictEqual(first, second)) return blocked('app-observation-changed');
    if (!isDeepStrictEqual(first, receipt.profile)) return blocked('visible-protection-drift');
    return { kind: 'visible-profile-matches-owner-audit' };
  } catch { return blocked('invalid-observation'); }
}
