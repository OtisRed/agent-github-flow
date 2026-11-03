const id=value=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value;
const oid=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value)&&value!=='0'.repeat(40);

// The subject is selected independently of the observed state, then bound to
// authenticated repository/Project/issue evidence by every step. These
// values and returned bindings are private context; do not log them.
export function isHandoffSubject(value) {
  return !!value&&typeof value==='object'&&!Array.isArray(value)
    &&['repositoryId','repository','projectId','statusFieldId','issueId'].every(key=>id(value[key]))
    &&Number.isSafeInteger(value.issueNumber)&&value.issueNumber>0
    &&[value.appId,value.updateRulesetId,value.historyRulesetId].every(x=>Number.isSafeInteger(x)&&x>0)
    &&value.updateRulesetId!==value.historyRulesetId&&Array.isArray(value.trustedAuthorIds)
    &&value.trustedAuthorIds.length>0&&value.trustedAuthorIds.every(id)
    &&new Set(value.trustedAuthorIds).size===value.trustedAuthorIds.length;
}
export function matchesHandoffSubject(observation,subject) {
  return isHandoffSubject(subject)&&observation?.checkpoint?.repositoryId===subject.repositoryId
    &&observation.checkpoint.repositoryFullName===subject.repository
    &&observation.checkpoint.selection?.issueId===subject.issueId
    &&observation.checkpoint.selection?.number===subject.issueNumber
    &&observation.project?.repository===subject.repository&&observation.project.projectId===subject.projectId
    &&observation.project.issueNodeId===subject.issueId&&observation.project.statusFieldId===subject.statusFieldId
    &&Array.isArray(observation.trustedAuthorIds)&&observation.trustedAuthorIds.length===subject.trustedAuthorIds.length
    &&observation.trustedAuthorIds.every((value,index)=>value===subject.trustedAuthorIds[index]);
}
export function handoffSubject(subject) {
  if(!isHandoffSubject(subject))return null;
  return {repositoryId:subject.repositoryId,repository:subject.repository,projectId:subject.projectId,statusFieldId:subject.statusFieldId,
    issueId:subject.issueId,issueNumber:subject.issueNumber,appId:subject.appId,updateRulesetId:subject.updateRulesetId,
    historyRulesetId:subject.historyRulesetId,trustedAuthorIds:[...subject.trustedAuthorIds]};
}
export function handoffBinding(subject,commentId,commentDigest,checkpointOid) {
  if(!isHandoffSubject(subject)||!id(commentId)||typeof commentDigest!=='string'||!/^[a-f0-9]{64}$/.test(commentDigest)||!oid(checkpointOid)) return null;
  return {...handoffSubject(subject),commentId,commentDigest,checkpointOid};
}
