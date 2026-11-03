import { CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF } from './flow-checkpoint-registration.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const nonempty = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const hasRule = (rules, type, id, repo) => Array.isArray(rules) && rules.some(rule => rule?.type === type
  && rule.ruleset_id === id && rule.ruleset_source_type === 'Repository' && rule.ruleset_source === repo);
const hasDetailRule = (ruleset, type) => Array.isArray(ruleset.rules) && ruleset.rules.some(rule => rule?.type === type);
const validRuleSet = (value, repo) => value && positiveId(value.id) && value.target === 'branch'
  && value.source_type === 'Repository' && value.source === repo && value.enforcement === 'active'
  && Array.isArray(value.rules) && Array.isArray(value.bypass_actors);
const exactScope = value => {
  const names = [CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF];
  const ref = value?.conditions?.ref_name;
  return Array.isArray(ref?.include) && ref.include.length === names.length && new Set(ref.include).size === names.length
    && names.every(name => ref.include.includes(name)) && Array.isArray(ref.exclude) && ref.exclude.length === 0;
};

// For a separate authorized audit with an identity that can see bypass actors.
// Raw results must be obtained from a trusted complete fresh read of the exact
// repo, both rulesets and effective rules for both ref names. Missing bypass
// data blocks; this observation is not an execution permit or a guarantee
// against later admin changes. Do not log private repo metadata or receipts.
export function auditCheckpointProtection(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !nonempty(input.repositoryId)
      || !nonempty(input.repository) || !positiveId(input.appId)
      || typeof input.expectedPrivate !== 'boolean' || input.repositoryData?.private !== input.expectedPrivate
      || input.repositoryData?.fork !== false
      || input.repositoryData?.node_id !== input.repositoryId || input.repositoryData?.full_name !== input.repository
      || !nonempty(input.repositoryData?.default_branch)
      || [CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF].includes(`refs/heads/${input.repositoryData.default_branch}`)
      || !Array.isArray(input.effective) || input.effective.length !== 2) return blocked('invalid-input');
  const { updateRuleset, historyRuleset, appId, repository } = input;
  if (!validRuleSet(updateRuleset, repository) || !validRuleSet(historyRuleset, repository)
      || updateRuleset.id === historyRuleset.id) return blocked('ruleset-details-unavailable');
  if (!exactScope(updateRuleset) || !exactScope(historyRuleset)) return blocked('unsafe-ruleset-scope');
  if (updateRuleset.rules.length !== 1 || historyRuleset.rules.length !== 2
      || !hasDetailRule(updateRuleset, 'update') || !hasDetailRule(historyRuleset, 'deletion')
      || !hasDetailRule(historyRuleset, 'non_fast_forward')) return blocked('unexpected-rules');
  const update = updateRuleset.rules.filter(rule => rule?.type === 'update');
  if (update.length !== 1 || Object.keys(update[0]).some(key => !['type', 'parameters'].includes(key))) return blocked('unsafe-update-rule');
  let updateFetchAndMerge = 'not-applicable-nonfork';
  if (Object.hasOwn(update[0], 'parameters')) {
    const parameters = update[0].parameters;
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)
        || Object.keys(parameters).length !== 1 || parameters.update_allows_fetch_and_merge !== false) return blocked('unsafe-update-rule');
    updateFetchAndMerge = 'disabled-explicit';
  }
  const actors = updateRuleset.bypass_actors;
  if (actors.length !== 1 || actors[0]?.actor_type !== 'Integration' || actors[0]?.actor_id !== appId
      || actors[0]?.bypass_mode !== 'always' || historyRuleset.bypass_actors.length !== 0) return blocked('unexpected-bypass');
  const names = [CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF];
  if (new Set(input.effective.map(value => value?.ref)).size !== names.length) return blocked('invalid-ref-evidence');
  for (const name of names) {
    const evidence = input.effective.find(value => value?.ref === name);
    if (!evidence || !Array.isArray(evidence.rules) || evidence.rules.some(rule => !nonempty(rule?.type)
        || !positiveId(rule.ruleset_id) || !nonempty(rule.ruleset_source_type) || !nonempty(rule.ruleset_source))
        || new Set(evidence.rules.map(rule => `${rule.ruleset_id}:${rule.type}`)).size !== evidence.rules.length) {
      return blocked('invalid-effective-rules');
    }
    if (!hasRule(evidence.rules, 'update', updateRuleset.id, repository)
        || !hasRule(evidence.rules, 'deletion', historyRuleset.id, repository)
        || !hasRule(evidence.rules, 'non_fast_forward', historyRuleset.id, repository)) return blocked('required-rules-not-effective');
  }
  return { kind: 'checkpoint-protection-observed', repositoryId: input.repositoryId,
    updateRulesetId: updateRuleset.id, historyRulesetId: historyRuleset.id, appId, updateFetchAndMerge };
}
