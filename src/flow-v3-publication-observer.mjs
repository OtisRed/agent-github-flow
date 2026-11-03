import { createV3CheckpointGitReader } from './flow-v3-git-reader.mjs';
import { observeCheckpointPublication } from './flow-checkpoint-publication-observer.mjs';

// Verifies ref pair and commit only. The surrounding publication step must
// also re-read the full inventory and issue/Project evidence after success.
export function createV3PublicationObserver(input={}){
  let policy;try{policy=structuredClone(input.policy);}catch{throw Error('invalid-v3-publication-observer');}
  const reader=createV3CheckpointGitReader({...input,policy}),repositoryId=policy.repositoryId;
  return async({oldOid,newOid,expectedTreeOid}={})=>observeCheckpointPublication({repositoryId,oldOid,newOid,expectedTreeOid,
    readRepository:reader.readRepository,readRef:reader.readRef,readCommit:reader.readCommit});
}
