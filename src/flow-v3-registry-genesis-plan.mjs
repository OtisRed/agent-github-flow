import { encodeV3Registry } from './flow-v3-registry.mjs';
import { createV3RegistryAnchor } from './flow-v3-registry-anchor.mjs';
import { V3_REGISTRY_REF,V3_REGISTRY_ANCHOR_REF } from './flow-v3-registry-git-plan.mjs';

const id=value=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value&&!/[\x00-\x1f\x7f]/.test(value);
const repo=value=>typeof value==='string'&&/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(value)&&!['.','..'].includes(value.split('/')[1]);
const b64=value=>Buffer.from(value,'utf8').toString('base64');
const blocked=reason=>({kind:'blocked',reason});

// Pure initial content, not permission to create either ref. The caller must
// authenticate both repos, detect any previous initialization, establish a
// protected durable key and independently pin both resulting registry roots.
// Since repos cannot be mutated atomically, recovery of partial creation must
// be established before using this plan in a real installation.
export function planV3RegistryGenesis({privateRepository,privateRepositoryId,anchorRepository,anchorRepositoryId,keyring}={}){
  try{
    if(!repo(privateRepository)||!repo(anchorRepository)||!id(privateRepositoryId)||!id(anchorRepositoryId)
        ||privateRepository.toLowerCase()===anchorRepository.toLowerCase()||privateRepositoryId===anchorRepositoryId)
      return blocked('invalid-registry-genesis-subject');
    const registry={version:1,revision:1,entries:[]},encoded=encodeV3Registry(registry);
    const anchored=createV3RegistryAnchor(registry,keyring);
    if(encoded.kind!=='encoded-v3-registry'||anchored.kind!=='v3-registry-anchor-planned')return blocked('registry-genesis-unavailable');
    const anchorText=JSON.stringify(anchored.anchor);
    return {kind:'v3-registry-genesis-plan',private:{repository:privateRepository,repositoryId:privateRepositoryId,expectedPrivate:true,
      ref:V3_REGISTRY_REF,parents:[],files:[{path:'registry.json',contents:b64(encoded.content)},{path:'anchor.json',contents:b64(anchorText)}]},
    anchor:{repository:anchorRepository,repositoryId:anchorRepositoryId,expectedPrivate:false,ref:V3_REGISTRY_ANCHOR_REF,parents:[],
      files:[{path:'anchor.json',contents:b64(anchorText)}]}};
  }catch{return blocked('registry-genesis-unavailable');}
}
