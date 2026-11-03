import { encodeProjectRegistrationV3 } from './flow-project-registration-v3.mjs';
import { encodeCheckpointV3 } from './flow-checkpoint-v3.mjs';
import { parseFlowComment } from './flow.mjs';

const blocked=reason=>({kind:'blocked',reason});
const id=value=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value;

// Pure verification of authenticated observations, never a write permit.
// Callers must freshly read the repository, exact Project/options and the
// saved comments (only IDs referenced by the record), prove completeness/latest selection and protect the config,
// keyring and branch. Nothing private is included in the result or logged.
export function verifyV3Commitments(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input)||encodeProjectRegistrationV3(input.registration).kind!=='encoded-registration'
      ||encodeCheckpointV3(input.record).kind!=='encoded-record'||!input.keyring||typeof input.keyring.forId!=='function'
      ||!Array.isArray(input.comments)||input.comments.length>100)return blocked('invalid-input');
  const {registration,record,keyring,comments,repository,project}=input;
  if(record.repositoryId!==registration.repositoryId||record.cutoverAt!==registration.checkpoint.cutoverAt
      ||repository?.node_id!==registration.repositoryId||repository.full_name!==registration.repository
      ||repository.private!==registration.expectedPrivate||repository.fork!==false
      ||project?.kind!=='branch-project-observed'||project.repository!==registration.repository||project.issueNodeId!==record.issueId
      ||project.projectId!==registration.projectId||project.statusFieldId!==registration.statusFieldId||project.statusFieldName!==registration.statusFieldName
      ||!Array.isArray(project.statusOptions)||project.statusOptions.length!==registration.statusOptions.length)return blocked('observation-mismatch');
  const names=new Set(),ids=new Set();
  for(const option of project.statusOptions){
    if(!option||!id(option.name)||!id(option.id)||names.has(option.name)||ids.has(option.id))return blocked('invalid-status-options');
    names.add(option.name);ids.add(option.id);
    if(!registration.statusOptions.some(expected=>expected.name===option.name&&expected.id===option.id))return blocked('status-option-mismatch');
  }
  const byId=new Map();
  for(const comment of comments){
    if(!comment||typeof comment.id!=='string'||!/^[1-9][0-9]{0,19}$/.test(comment.id)||byId.has(comment.id)
        ||!id(comment.authorId)||typeof comment.createdAt!=='string'||typeof comment.body!=='string')return blocked('invalid-comments');
    byId.set(comment.id,comment);
  }
  const markers=[record.current,record.previous,record.reentry?.previous??null].filter(Boolean);
  try{
    for(const marker of markers){
      const config=keyring.forId(marker.configKeyId),commentKey=keyring.forId(marker.commentKeyId);
      if(!config.verifyConfig(registration,marker.configMac))return blocked('configuration-commitment-mismatch');
      const comment=byId.get(marker.commentId);
      if(!comment||comment.createdAt!==marker.createdAt||!registration.trustedAuthorIds.includes(comment.authorId))return blocked('comment-unavailable');
      const parsed=parseFlowComment(comment.body);
      if(!parsed.ok||parsed.targetStatus!==marker.targetStatus
          ||!commentKey.verifyComment({repositoryId:record.repositoryId,issueId:record.issueId,commentId:marker.commentId,body:comment.body},marker.commentMac))
        return blocked('comment-commitment-mismatch');
    }
  }catch{return blocked('commitment-key-unavailable');}
  return {kind:'v3-commitments-verified'};
}
