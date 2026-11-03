import { verifyV3Registry } from './flow-v3-registry-anchor.mjs';

export const V3_REGISTRY_REF='refs/heads/agent-github-flow/registry';
export const V3_REGISTRY_ANCHOR_REF='refs/heads/agent-github-flow/registry-anchor';
const oid=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value)&&value!=='0'.repeat(40);
const id=value=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value&&!/[\x00-\x1f\x7f]/.test(value);
const repo=value=>typeof value==='string'&&/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(value)&&!['.','..'].includes(value.split('/')[1]);
const blocked=reason=>({kind:'blocked',reason});
const contents=value=>Buffer.from(value,'utf8').toString('base64');

// Pure tree plan only. Caller must authenticate branch ownership, App token,
// expected HEAD, provenance, protection and a legal predecessor transition.
// Private plans contain confidential Project configuration; never log them.
export function planV3RegistryGitUpdate(input={}){
  try{
    const {keyring}=input;const value=structuredClone({role:input.role,repository:input.repository,repositoryId:input.repositoryId,
      expectedPrivate:input.expectedPrivate,expectedHeadOid:input.expectedHeadOid,baseTreeOid:input.baseTreeOid,
      content:input.content,anchor:input.anchor});
    if(!['private','anchor'].includes(value.role)||!repo(value.repository)||!id(value.repositoryId)
        ||typeof value.expectedPrivate!=='boolean'||value.expectedPrivate!==(value.role==='private')
        ||!oid(value.expectedHeadOid)||!oid(value.baseTreeOid)
        ||verifyV3Registry(value.content,value.anchor,keyring).kind!=='v3-registry-verified')return blocked('invalid-registry-plan');
    const {anchor}=value,anchorText=JSON.stringify({version:anchor.version,revision:anchor.revision,keyId:anchor.keyId,mac:anchor.mac});
    const additions=value.role==='private'
      ?[{path:'registry.json',contents:contents(value.content)},{path:'anchor.json',contents:contents(anchorText)}]
      :[{path:'anchor.json',contents:contents(anchorText)}];
    return {kind:'v3-registry-git-plan',role:value.role,repository:value.repository,repositoryId:value.repositoryId,
      expectedPrivate:value.expectedPrivate,ref:value.role==='private'?V3_REGISTRY_REF:V3_REGISTRY_ANCHOR_REF,
      expectedHeadOid:value.expectedHeadOid,baseTreeOid:value.baseTreeOid,additions};
  }catch{return blocked('invalid-registry-plan');}
}
