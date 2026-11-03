import { isDeepStrictEqual } from 'node:util';
import { isCheckpointRegistration } from './flow-checkpoint-registration.mjs';
import { readCheckpointRegistration } from './flow-checkpoint-registration-reader.mjs';
import { readCheckpointTreePlan } from './flow-checkpoint-tree-reader.mjs';
import { decodeCheckpointGitBlob } from './flow-checkpoint-git-blob.mjs';

const blocked=reason=>({kind:'blocked',reason});
const oid=value=>typeof value==='string'&&/^[0-9a-f]{40}$/.test(value)&&value!=='0'.repeat(40);
const markerEntry=(tree,treeOid)=>{
  if(tree?.sha!==treeOid||tree.truncated!==false||!Array.isArray(tree.tree))return null;
  const entries=tree.tree.filter(item=>item?.path==='checkpoint-schema.json');
  const entry=entries[0];
  return entries.length===1&&entry.type==='blob'&&entry.mode==='100644'&&oid(entry.sha)
    &&Number.isSafeInteger(entry.size)&&entry.size>=0&&entry.size<=1024?entry:null;
};

// Read-only verification with trusted, repository-scoped Git transports and
// independently protected registration. It confirms a dedicated empty v2
// genesis marker and current ancestry/marker, not exclusive past writers,
// rollback protection, ruleset protection or permission to publish.
export async function verifyV2Bootstrap(input={}) {
  let registration;try{registration=structuredClone(input.registration);}catch{return blocked('invalid-registration');}
  if(!isCheckpointRegistration(registration)||registration.checkpointSchemaVersion!==2||!oid(registration.genesisOid)
      ||!['readRepository','readRef','compare','readCommit','readTree','readBlob'].every(key=>typeof input[key]==='function'))
    return blocked('invalid-input');
  const {readRepository,readRef,compare,readCommit,readTree,readBlob}=input;
  const registrationInput={registration,readRepository,readRef,compare};
  try {
    const first=await readCheckpointRegistration(registrationInput);
    if(first.kind!=='genesis-ancestry-observed'||first.pairedRefs!==true)return blocked('registration-unverified');
    const genesisCommit=structuredClone(await readCommit(registration.genesisOid));
    if(genesisCommit?.sha!==registration.genesisOid||!Array.isArray(genesisCommit.parents)||genesisCommit.parents.length!==0)
      return blocked('genesis-not-root');
    const genesis=await readCheckpointTreePlan({commitOid:registration.genesisOid,repositoryId:registration.repositoryId,readCommit,readTree,readBlob});
    if(genesis.kind!=='record-reads-planned'||genesis.treeOid!==genesisCommit.tree?.sha
      ||genesis.records.length!==0||genesis.index.issues.length!==0)return blocked('genesis-not-empty');
    const genesisTree=structuredClone(await readTree(genesis.treeOid,{recursive:true})),marker=markerEntry(genesisTree,genesis.treeOid);
    if(!marker||genesisTree.tree.length!==2||!genesisTree.tree.some(entry=>entry?.path==='index.json'))return blocked('invalid-genesis-tree');
    const markerBlob=structuredClone(await readBlob(marker.sha));
    if(markerBlob?.size!==marker.size)return blocked('invalid-marker');
    const decoded=decodeCheckpointGitBlob({expectedOid:marker.sha,blob:markerBlob});
    const expected=JSON.stringify({version:2,repositoryId:registration.repositoryId,cutoverAt:registration.cutoverAt});
    if(decoded.kind!=='decoded-blob'||decoded.content!==expected)return blocked('invalid-marker');
    const headCommit=structuredClone(await readCommit(first.headOid));
    if(headCommit?.sha!==first.headOid||!oid(headCommit.tree?.sha))return blocked('invalid-head');
    const headTree=structuredClone(await readTree(headCommit.tree.sha,{recursive:true})),headMarker=markerEntry(headTree,headCommit.tree.sha);
    if(!headMarker||headMarker.sha!==marker.sha||headMarker.size!==marker.size)return blocked('marker-changed');
    const last=await readCheckpointRegistration(registrationInput);
    if(!isDeepStrictEqual(first,last))return blocked('registration-changed');
    return {kind:'v2-bootstrap-verified',registration};
  } catch { return blocked('bootstrap-read-failed'); }
}

// Adapts trusted transports to the cycle's verifyBootstrap(registration)
// interface while pinning configuration independently of observed input.
export function createV2BootstrapVerifier(input={}) {
  if(!isCheckpointRegistration(input.registration)||input.registration.checkpointSchemaVersion!==2
      ||!['readRepository','readRef','compare','readCommit','readTree','readBlob'].every(key=>typeof input[key]==='function'))
    throw Error('invalid-v2-bootstrap-adapter');
  const registration=structuredClone(input.registration);
  const {readRepository,readRef,compare,readCommit,readTree,readBlob}=input;
  return async observed=>isDeepStrictEqual(observed,registration)
    ?verifyV2Bootstrap({registration,readRepository,readRef,compare,readCommit,readTree,readBlob})
    :blocked('registration-mismatch');
}
