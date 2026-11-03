import { encodeCheckpointIndex } from './flow-checkpoint-index.mjs';
import { parseFlowTimestamp } from './flow-epoch.mjs';

const blocked=reason=>({kind:'blocked',reason});
const content=value=>Buffer.from(value,'utf8').toString('base64');

// Pure bootstrap construction only. No repository access or permission to
// create refs; the caller must separately enforce one-time registration,
// exclusive writers, privacy policy and protected bootstrap procedure.
export function planV2Genesis(input) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==2
      ||!Object.hasOwn(input,'repositoryId')||!Object.hasOwn(input,'cutoverAt')
      ||parseFlowTimestamp(input.cutoverAt)===null)return blocked('invalid-input');
  const index=encodeCheckpointIndex({version:1,repositoryId:input.repositoryId,issues:[]});
  if(index.kind!=='encoded-index')return blocked('invalid-input');
  const marker=JSON.stringify({version:2,repositoryId:input.repositoryId,cutoverAt:input.cutoverAt});
  return {kind:'v2-genesis-plan',parents:[],files:[{path:'checkpoint-schema.json',contents:content(marker)},
    {path:'index.json',contents:content(index.content)}]};
}
