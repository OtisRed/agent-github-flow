import { isDeepStrictEqual } from 'node:util';
import { isHandoffSubject } from './flow-handoff-binding.mjs';
import { isCheckpointRegistration } from './flow-checkpoint-registration.mjs';
import { createCheckpointObjectPreparer } from './flow-checkpoint-object-preparer.mjs';

// Connects the v2 cycle to the real scoped preparer. This does not prove
// bootstrap, branch protection, serialization or authorize ref publication.
// The caller must supply protected policy and registration and an App token
// scoped to the selected private repository; values must never be logged.
export function createV2PreparationAdapter({policy,registration,appToken,request=fetch}={}) {
  if (!isHandoffSubject(policy) || !isCheckpointRegistration(registration) || registration.checkpointSchemaVersion!==2
      || registration.repositoryId!==policy.repositoryId || typeof request!=='function') throw Error('invalid-v2-adapter');
  policy=structuredClone(policy);registration=structuredClone(registration);
  const parts=policy.repository.split('/');
  if(parts.length!==2)throw Error('invalid-v2-adapter');
  return async ({snapshot,after,registration:observed}={})=>{
    if(!isDeepStrictEqual(observed,registration)||snapshot?.schemaVersion!==2||snapshot.repositoryId!==policy.repositoryId
        ||snapshot.repositoryFullName!==policy.repository||snapshot.cutoverAt!==registration.cutoverAt
        ||snapshot.selection?.issueId!==policy.issueId||snapshot.selection?.number!==policy.issueNumber
        ||after?.issueId!==policy.issueId||after?.number!==policy.issueNumber) return {kind:'blocked',reason:'adapter-subject-mismatch'};
    try {
      return await createCheckpointObjectPreparer({owner:parts[0],repo:parts[1],snapshot,after,registration,appToken,request}).prepare();
    } catch { return {kind:'blocked',reason:'adapter-preparation-unavailable'}; }
  };
}
