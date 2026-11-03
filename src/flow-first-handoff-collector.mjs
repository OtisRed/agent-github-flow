import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { isHandoffSubject, matchesHandoffSubject } from './flow-handoff-binding.mjs';
import { readRegisteredCheckpointSnapshot } from './flow-checkpoint-registered-snapshot.mjs';
import { readBranchProjectIssue } from './flow-github-split-project.mjs';
import { collectHandoffEvidence } from './flow-handoff-reader.mjs';
import { collectEpochEvidence } from './flow-epoch-reader.mjs';
import { matchesHandoffEpoch } from './flow-epoch-proof.mjs';
import { encodeProjectRegistrationV3 } from './flow-project-registration-v3.mjs';
import { verifyV3ProjectContext, verifyV3Commitments } from './flow-v3-commitment-verifier.mjs';

const blocked=reason=>({kind:'blocked',reason});
const id=value=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value;
const repoIdentity=value=>({node_id:value?.node_id,full_name:value?.full_name,private:value?.private,fork:value?.fork,default_branch:value?.default_branch});

// Read-only composition for a first handoff in its initial epoch. Configuration,
// clock and Git/App/Project transports must be independently trusted and
// scoped to this subject. No returned observation authorizes a write. Do not
// log the returned private context. Repeated full Project scans are deliberately
// conservative and require performance work before deployment to large boards.
async function collectOnce(input={}) {
  let policy,registration,projectRegistration;try{policy=structuredClone(input.policy);registration=structuredClone(input.registration);
    projectRegistration=structuredClone(input.projectRegistration);}catch{return blocked('invalid-input');}
  const {projectOwner,projectNumber,statusFieldName,git,projectGraphql,issueGraphql,listItems,now}=input;
  if(!isHandoffSubject(policy)||!registration||registration.repositoryId!==policy.repositoryId
      ||!/^[A-Za-z0-9-]{1,39}$/.test(projectOwner??'')||!Number.isSafeInteger(projectNumber)||projectNumber<1
      ||!id(statusFieldName)||!git||!['readRepository','readRef','compare','readCommit','readTree','readBlob'].every(x=>typeof git[x]==='function')
      ||![projectGraphql,issueGraphql,listItems,now].every(x=>typeof x==='function'))return blocked('invalid-input');
  const parts=policy.repository.split('/');
  if(parts.length!==2||!/^[A-Za-z0-9-]{1,39}$/.test(parts[0])||!/^[A-Za-z0-9_.-]{1,100}$/.test(parts[1])||['.','..'].includes(parts[1]))return blocked('invalid-input');
  const v3=registration.checkpointSchemaVersion===3,keyring=input.keyring;
  if(v3&&(encodeProjectRegistrationV3(projectRegistration).kind!=='encoded-registration'
      ||!isDeepStrictEqual(projectRegistration.checkpoint,registration)||projectRegistration.repositoryId!==policy.repositoryId
      ||projectRegistration.repository!==policy.repository||projectRegistration.projectId!==policy.projectId
      ||projectRegistration.statusFieldId!==policy.statusFieldId||projectRegistration.statusFieldName!==statusFieldName
      ||projectRegistration.projectOwner!==projectOwner||projectRegistration.projectNumber!==projectNumber
      ||projectRegistration.appId!==policy.appId||projectRegistration.updateRulesetId!==policy.updateRulesetId
      ||projectRegistration.historyRulesetId!==policy.historyRulesetId||!isDeepStrictEqual(projectRegistration.trustedAuthorIds,policy.trustedAuthorIds)
      ||!keyring||typeof keyring.forId!=='function'||typeof keyring.current!=='function'))return blocked('v3-policy-mismatch');
  const snapshotInput={registration,selection:{number:policy.issueNumber,issueId:policy.issueId},
    readRepository:git.readRepository,readRef:git.readRef,compare:git.compare,readCommit:git.readCommit,readTree:git.readTree,readBlob:git.readBlob};
  try {
    const checkpoint=await readRegisteredCheckpointSnapshot(snapshotInput);
    if(checkpoint.kind!=='checkpoint-snapshot-observed')return blocked('checkpoint-unavailable');
    if(checkpoint.repositoryFullName!==policy.repository)return blocked('repository-mismatch');
    const project=await readBranchProjectIssue({projectOwner,projectNumber,number:policy.issueNumber,projectId:policy.projectId,
      issueId:policy.issueId,repository:policy.repository,statusFieldId:policy.statusFieldId,statusFieldName,
      projectGraphql,issueGraphql,listItems});
    if(project.kind!=='branch-project-observed')return blocked('project-unavailable');
    let repository;
    if(v3){
      repository=repoIdentity(structuredClone(await git.readRepository()));
      if(verifyV3ProjectContext({registration:projectRegistration,repository,project,issueId:policy.issueId}).kind!=='v3-project-context-verified')
        return blocked('v3-context-unverified');
      const current=keyring.current();
      if(!current||!Number.isSafeInteger(current.keyId)||current.keyId<1||typeof current.comment!=='function'||typeof current.config!=='function')
        return blocked('v3-key-unavailable');
    }
    const record=checkpoint.selectedRecord;
    if(record!==null&&(record.epoch?.kind!=='initial'||!['pending','committed'].includes(record.current?.phase)||record.previous!==null||record.reentry!==null))return blocked('unsupported-checkpoint');
    const handoffRead=await collectHandoffEvidence({owner:parts[0],repo:parts[1],number:policy.issueNumber,
      trustedAuthorIds:policy.trustedAuthorIds,graphql:issueGraphql,
      ...(record===null?{cutoverAt:registration.cutoverAt}:{checkpointCommentId:record.current.commentId})});
    if(handoffRead.kind!=='evidence'||handoffRead.handoff?.kind!=='handoff')return blocked('handoff-unavailable');
    if(!v3&&record!==null&&(handoffRead.previousComment?.id!==record.current.commentId
      ||handoffRead.previousComment?.createdAt!==record.current.createdAt||typeof handoffRead.previousComment?.body!=='string'
      ||createHash('sha256').update(handoffRead.previousComment.body,'utf8').digest('hex')!==record.current.digest))return blocked('checkpoint-comment-mismatch');
    if(v3&&record!==null&&verifyV3Commitments({registration:projectRegistration,record,keyring,repository,project,
      comments:handoffRead.previousComment?[handoffRead.previousComment]:[]}).kind!=='v3-commitments-verified')return blocked('v3-commitments-unverified');
    // In checkpoint mode the reader also verifies that the saved comment is
    // present and unedited. Do not return its extra copy, so that a successful
    // pending publication does not itself change the collected evidence shape.
    const handoffEvidence={kind:'evidence',handoff:handoffRead.handoff,commentCount:handoffRead.commentCount};
    const epochProof=await collectEpochEvidence({owner:parts[0],repo:parts[1],number:policy.issueNumber,
      commentNodeId:handoffEvidence.handoff.nodeId,observedAt:now(),graphql:issueGraphql});
    const epoch=record===null?{kind:'initial',anchor:policy.issueId}:record.epoch;
    if(!matchesHandoffEpoch({issueNodeId:policy.issueId,epoch},handoffEvidence.handoff,epochProof))return blocked('epoch-unverified');
    const last=await readRegisteredCheckpointSnapshot(snapshotInput);
    if(!isDeepStrictEqual(checkpoint,last))return blocked('checkpoint-changed');
    if(v3&&!isDeepStrictEqual(repository,repoIdentity(structuredClone(await git.readRepository()))))return blocked('repository-changed');
    const observation={checkpoint,project,handoffEvidence,epochProof,trustedAuthorIds:[...policy.trustedAuthorIds],expectedProjectId:policy.projectId};
    if(!matchesHandoffSubject(observation,policy))return blocked('subject-mismatch');
    return observation;
  } catch { return blocked('collection-unavailable'); }
}

// A complete second composition catches changes after any individual reader's
// local readback. It is still not an atomic snapshot across Git/Project/Issue.
export async function collectFirstHandoffSnapshot(input={}) {
  let stable;try{stable={...input,policy:structuredClone(input.policy),registration:structuredClone(input.registration),
    projectRegistration:structuredClone(input.projectRegistration)};}
  catch{return blocked('invalid-input');}
  const first=await collectOnce(stable);
  if(first?.kind==='blocked')return first;
  const second=await collectOnce(stable);
  if(second?.kind==='blocked'||!isDeepStrictEqual(first,second))return blocked('snapshot-changed');
  return first;
}
