import { planV2Genesis } from './flow-v2-genesis-plan.mjs';

// Pure construction only. A protected registration, initialization policy,
// repository visibility and write authority must be established separately.
export function planV3Genesis(input) {
  const plan=planV2Genesis(input);
  if(plan.kind!=='v2-genesis-plan')return plan;
  const marker=JSON.stringify({version:3,repositoryId:input.repositoryId,cutoverAt:input.cutoverAt});
  return {kind:'v3-genesis-plan',parents:[],files:[
    {path:'checkpoint-schema.json',contents:Buffer.from(marker,'utf8').toString('base64')},
    plan.files[1]
  ]};
}
