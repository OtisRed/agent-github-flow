import { isDeepStrictEqual } from 'node:util';
import { encodeProjectRegistration } from './flow-project-registration.mjs';
import { encodeProjectRegistrationV3 } from './flow-project-registration-v3.mjs';

export const ISSUE_IDENTITY_QUERY=`query FlowIssueIdentity($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){id nameWithOwner issue(number:$number){id number}}}`;
const blocked=reason=>({kind:'blocked',reason});
const id=value=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value&&!/[\x00-\x1f\x7f]/.test(value);

// Read-only. The caller must load/authenticate the private registration from a
// trusted source and bind the candidate to its selected route. A wakeup and
// this identity read alone never authorize a Project or Git mutation.
export async function resolveProjectPolicy(input={}){
  return resolvePolicy(input,false);
}

// The HMAC commitment is an independently protected input. It authenticates
// the full v3 registration before any route lookup; it does not prove App
// identity, prevent registry rollback or authorize mutation.
export async function resolveV3ProjectPolicy(input={}){
  return resolvePolicy(input,true);
}

async function resolvePolicy(input,v3){
  if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.graphql!=='function')return blocked('invalid-input');
  let registration,candidate;try{registration=structuredClone(input.registration);candidate=structuredClone(input.candidate);}catch{return blocked('invalid-input');}
  if((v3?encodeProjectRegistrationV3(registration):encodeProjectRegistration(registration)).kind!=='encoded-registration')return blocked('invalid-input');
  if(v3){
    try{const commitment=structuredClone(input.registrationCommitment),keyring=input.keyring;
      if(!commitment||Object.keys(commitment).length!==2||!Number.isSafeInteger(commitment.keyId)||commitment.keyId<1
          ||typeof commitment.mac!=='string'||typeof keyring?.forId!=='function'||!keyring.forId(commitment.keyId).verifyConfig(registration,commitment.mac))
        return blocked('registration-unverified');
    }catch{return blocked('registration-unverified');}
  }
  if(input.source!==registration.source||!candidate||typeof candidate!=='object'||Array.isArray(candidate)
      ||Object.keys(candidate).length!==3||candidate.kind!=='candidate'||candidate.repository!==registration.repository
      ||!Number.isSafeInteger(candidate.issueNumber)||candidate.issueNumber<1)return blocked('route-mismatch');
  const [owner,repo]=registration.repository.split('/');
  const read=async()=>{
    const response=structuredClone(await input.graphql(ISSUE_IDENTITY_QUERY,{owner,repo,number:candidate.issueNumber}));
    if(!response||(response.errors!=null&&(!Array.isArray(response.errors)||response.errors.length))||!response.data)return null;
    const repository=response.data.repository,issue=repository?.issue;
    if(repository?.id!==registration.repositoryId||repository.nameWithOwner!==registration.repository
        ||!id(issue?.id)||issue.number!==candidate.issueNumber)return null;
    return {repositoryId:repository.id,repository:repository.nameWithOwner,issueId:issue.id,issueNumber:issue.number};
  };
  try{
    const first=await read();if(!first)return blocked('issue-identity-unavailable');
    const second=await read();if(!second||!isDeepStrictEqual(first,second))return blocked('issue-identity-changed');
    return {kind:'project-policy-resolved',policy:{...first,projectId:registration.projectId,statusFieldId:registration.statusFieldId,
      trustedAuthorIds:[...registration.trustedAuthorIds],appId:registration.appId,updateRulesetId:registration.updateRulesetId,
      historyRulesetId:registration.historyRulesetId},projectOwner:registration.projectOwner,projectNumber:registration.projectNumber,
      statusFieldName:registration.statusFieldName,checkpoint:registration.checkpoint};
  }catch{return blocked('issue-identity-unavailable');}
}
