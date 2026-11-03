import { CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF } from './flow-checkpoint-registration.mjs';
import { planV3Genesis } from './flow-v3-genesis-plan.mjs';

const blocked=reason=>({kind:'blocked',reason});
const oid=value=>typeof value==='string'&&/^[0-9a-f]{40}$/.test(value)&&value!=='0'.repeat(40);
const refAt=(value,name,expected)=>value?.ref===name&&value.object?.type==='commit'&&value.object.sha===expected;

// A read-only observation after one bootstrap publication. It never grants a
// retry, verifies rules or registers the repo; all transports must be scoped and
// authenticated, and the marker/tree must be independently verified.
export async function observeV2GenesisPublication(input={}) {
  return observeGenesis(input,true,false);
}

// Read-only v3 check against an explicit protected setup intent. Root tree
// contents, protection, registration and token identity remain external.
export async function observeV3GenesisPublication(input={}){
  let intent;try{intent=structuredClone(input.setupIntent);}catch{return blocked('invalid-input');}
  if(!intent||typeof intent!=='object'||Array.isArray(intent)||Object.keys(intent).length!==4
      ||!['repository','repositoryId','expectedPrivate','cutoverAt'].every(key=>Object.hasOwn(intent,key))
      ||typeof intent.expectedPrivate!=='boolean'||planV3Genesis({repositoryId:intent.repositoryId,cutoverAt:intent.cutoverAt}).kind!=='v3-genesis-plan')
    return blocked('invalid-input');
  return observeGenesis({repositoryId:intent.repositoryId,repositoryFullName:intent.repository,genesisOid:input.genesisOid,
    expectedTreeOid:input.expectedTreeOid,readRepository:input.readRepository,readRef:input.readRef,readCommit:input.readCommit},intent.expectedPrivate,true);
}

async function observeGenesis(input,expectedPrivate,requireNotFork) {
  if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.repositoryId!=='string'||!input.repositoryId||input.repositoryId.length>256
      ||input.repositoryId.trim()!==input.repositoryId||!oid(input.genesisOid)||!oid(input.expectedTreeOid)
      ||typeof input.repositoryFullName!=='string'||!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(input.repositoryFullName)
      ||['.','..'].includes(input.repositoryFullName.split('/')[1])
      ||!['readRepository','readRef','readCommit'].every(key=>typeof input[key]==='function'))return blocked('invalid-input');
  const {repositoryId,repositoryFullName,genesisOid,expectedTreeOid,readRepository,readRef,readCommit}=input;
  try{
    const repository=structuredClone(await readRepository());
    if(repository?.node_id!==repositoryId||repository.full_name!==repositoryFullName||repository.private!==expectedPrivate
        ||(requireNotFork&&repository.fork!==false)
        ||typeof repository.default_branch!=='string'||!repository.default_branch
        ||[CHECKPOINT_BRANCH_REF,CHECKPOINT_ANCHOR_REF].includes(`refs/heads/${repository.default_branch}`))return blocked('repository-mismatch');
    const readPair=async()=>[structuredClone(await readRef(CHECKPOINT_BRANCH_REF)),structuredClone(await readRef(CHECKPOINT_ANCHOR_REF))];
    const pair=await readPair(),bothAbsent=pair[0]===null&&pair[1]===null;
    const bothAt=value=>refAt(value[0],CHECKPOINT_BRANCH_REF,genesisOid)&&refAt(value[1],CHECKPOINT_ANCHOR_REF,genesisOid);
    if(!bothAbsent&&!bothAt(pair))return blocked('unexpected-ref-pair');
    if(!bothAbsent){const commit=structuredClone(await readCommit(genesisOid));
      if(commit?.sha!==genesisOid||commit.tree?.sha!==expectedTreeOid||!Array.isArray(commit.parents)||commit.parents.length!==0)
        return blocked('unexpected-genesis');}
    const last=await readPair(),fresh=structuredClone(await readRepository());
    if(fresh?.node_id!==repositoryId||fresh.full_name!==repositoryFullName||fresh.private!==expectedPrivate
        ||(requireNotFork&&fresh.fork!==false)
        ||fresh.default_branch!==repository.default_branch||(bothAbsent?!(last[0]===null&&last[1]===null):!bothAt(last)))return blocked('observation-changed');
    return bothAbsent?{kind:'genesis-publication-not-observed',retryAllowed:false}:{kind:'genesis-publication-observed',retryAllowed:false};
  }catch{return blocked('genesis-observation-unavailable');}
}
