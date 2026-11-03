import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {collectFirstHandoffSnapshot} from './flow-first-handoff-collector.mjs';
import {BRANCH_PROJECT_QUERY,BRANCH_ISSUE_QUERY} from './flow-github-split-project.mjs';
import {HANDOFF_QUERY} from './flow-handoff-reader.mjs';
import {EPOCH_QUERY} from './flow-epoch-reader.mjs';
import {encodeCheckpointRecord} from './flow-checkpoint-record.mjs';

function fixture({phase=null}={}){
  const oid='a'.repeat(40),treeOid='b'.repeat(40),cutoverAt='2026-01-01T10:00:00Z';
  const text='[FLOW]\nRola: Designer\nStan docelowy: agent-ready\nWykonano: Praca\nNastępny krok: Kod';
  const bytes=Buffer.from(JSON.stringify({version:1,repositoryId:'repo-id',issues:phase?[{number:1,issueId:'issue'}]:[]}));
  const blobOid=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const state={comment:text,cardId:'item',appCalls:[],projectCalls:[],listCalls:0,epochReads:0,mutateAfterEpoch:null,
    statusName:'needs-design',statusOption:'design'};
  const registration={repositoryId:'repo-id',ref:'refs/heads/agent-github-flow/checkpoints',genesisOid:oid,cutoverAt};
  const policy={repositoryId:'repo-id',repository:'owner/project',projectId:'project',statusFieldId:'status',issueId:'issue',issueNumber:1,
    trustedAuthorIds:['user'],appId:12,updateRulesetId:1,historyRulesetId:2};
  const epoch={kind:'initial',anchor:'issue'};
  const record=phase?{version:1,repositoryId:'repo-id',number:1,issueId:'issue',cutoverAt,epoch,reentry:null,
    current:{phase,commentId:'4',digest:createHash('sha256').update(text).digest('hex'),fromStatus:'needs-design',targetStatus:'agent-ready',
      createdAt:'2026-01-01T10:01:00Z',epoch},previous:null}:null;
  const recordBytes=record?Buffer.from(encodeCheckpointRecord(record).content):null;
  const recordOid=recordBytes?createHash('sha1').update(`blob ${recordBytes.length}\0`).update(recordBytes).digest('hex'):null;
  const git={readRepository:async()=>({node_id:'repo-id',full_name:'owner/project',default_branch:'main'}),
    readRef:async ref=>({ref,object:{type:'commit',sha:oid}}),
    compare:async()=>({status:'identical',ahead_by:0,behind_by:0,base_commit:{sha:oid},merge_base_commit:{sha:oid},commits:[]}),
    readCommit:async()=>({sha:oid,tree:{sha:treeOid}}),
    readTree:async()=>({sha:treeOid,truncated:false,tree:[{path:'index.json',type:'blob',mode:'100644',sha:blobOid,size:bytes.length},
      ...(record?[{path:'issues',type:'tree',mode:'040000',sha:'e'.repeat(40)},
        {path:'issues/1.json',type:'blob',mode:'100644',sha:recordOid,size:recordBytes.length}]:[])]}),
    readBlob:async id=>{const data=id===blobOid?bytes:recordBytes;return {sha:id,size:data.length,encoding:'base64',content:data.toString('base64')};}};
  const projectGraphql=async(query,vars)=>{state.projectCalls.push({query,vars});assert.equal(query,BRANCH_PROJECT_QUERY);
    return {data:{user:{projectV2:{id:'project'}},node:{id:'item',isArchived:false,project:{id:'project',statusField:{id:'status',name:'Status',
      dataType:'SINGLE_SELECT',options:[{id:'design',name:'needs-design'},{id:'ready',name:'agent-ready'}]}},
      status:{name:state.statusName,optionId:state.statusOption,field:{id:'status'}}}}};};
  const issueGraphql=async(query,vars)=>{state.appCalls.push({query,vars});
    const common={id:'issue',state:'OPEN',createdAt:'2026-01-01T09:00:00Z',updatedAt:'2026-01-01T10:05:00Z'};
    if(query===BRANCH_ISSUE_QUERY)return {data:{node:{id:'issue',number:1,state:'OPEN',updatedAt:common.updatedAt,repository:{nameWithOwner:'owner/project'}}}};
    if(query===HANDOFF_QUERY)return {data:{repository:{issue:{...common,comments:{totalCount:1,pageInfo:{hasNextPage:false,endCursor:null},
      nodes:[{id:'comment',fullDatabaseId:'4',body:state.comment,createdAt:'2026-01-01T10:01:00Z',updatedAt:'2026-01-01T10:01:00Z',
        lastEditedAt:null,author:{__typename:'User',id:'user'}}]}}}}};
    if(query===EPOCH_QUERY){const response={data:{repository:{issue:{...common,timelineItems:{totalCount:0,updatedAt:common.updatedAt,nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}},
      node:{id:'comment',fullDatabaseId:'4',body:state.comment,createdAt:'2026-01-01T10:01:00Z',issue:{id:'issue'}}}};
      if(++state.epochReads===2&&state.mutateAfterEpoch==='status'){state.statusName='agent-ready';state.statusOption='ready';}
      if(state.epochReads===2&&state.mutateAfterEpoch==='comment')state.comment=state.comment.replace('agent-ready','review');return response;}
    throw Error('unexpected');};
  const listItems=async()=>{state.listCalls++;return {items:[{nodeId:state.cardId,contentNodeId:'issue',contentType:'Issue',archived:false}],nextCursor:null};};
  return {state,policy,registration,input:{policy,registration,projectOwner:'board-owner',projectNumber:1,statusFieldName:'Status',git,
    projectGraphql,issueGraphql,listItems,now:()=> '2026-01-01T10:10:00Z'}};
}
test('collects initial issue, card, latest handoff and epoch using separate trusted transports',async()=>{
  const f=fixture();const result=await collectFirstHandoffSnapshot(f.input);
  assert.equal(result.checkpoint?.kind,'checkpoint-snapshot-observed');assert.equal(result.project?.kind,'branch-project-observed');
  assert.equal(result.handoffEvidence?.handoff?.id,'4');assert.equal(result.epochProof?.epoch?.anchor,'issue');
  assert.equal(f.state.listCalls,4);assert.ok(f.state.appCalls.every(x=>[BRANCH_ISSUE_QUERY,HANDOFF_QUERY,EPOCH_QUERY].includes(x.query)));
});
test('blocks a status or handoff change after local readers finish but before the full recheck',async()=>{
  for(const change of ['status','comment']){const f=fixture();f.state.mutateAfterEpoch=change;
    assert.deepEqual(await collectFirstHandoffSnapshot(f.input),{kind:'blocked',reason:'snapshot-changed'});}
});
test('refuses wrong card, invalid latest comment or routing mismatch without leaking private input',async()=>{
  let f=fixture();f.state.cardId='other';assert.deepEqual(await collectFirstHandoffSnapshot(f.input),{kind:'blocked',reason:'project-unavailable'});
  f=fixture();f.state.comment='nonstandard';assert.deepEqual(await collectFirstHandoffSnapshot(f.input),{kind:'blocked',reason:'handoff-unavailable'});
  f=fixture();f.policy.repository='owner/other';assert.deepEqual(await collectFirstHandoffSnapshot(f.input),{kind:'blocked',reason:'repository-mismatch'});
  f=fixture();f.input.now=()=> 'invalid';assert.deepEqual(await collectFirstHandoffSnapshot(f.input),{kind:'blocked',reason:'epoch-unverified'});
});
test('collects existing first pending and committed handoffs for publication readback',async()=>{
  let f=fixture({phase:'pending'});let result=await collectFirstHandoffSnapshot(f.input);
  assert.equal(result.checkpoint?.selectedRecord?.current?.phase,'pending');assert.equal(result.handoffEvidence?.handoff?.id,'4');
  assert.equal(Object.hasOwn(result.handoffEvidence,'previousComment'),false);
  f=fixture({phase:'committed'});result=await collectFirstHandoffSnapshot(f.input);
  assert.equal(result.checkpoint?.selectedRecord?.current?.phase,'committed');assert.equal(result.handoffEvidence?.handoff?.id,'4');
});
test('preserves non-checkpoint evidence shape across first publication and completion',async()=>{
  const initial=await collectFirstHandoffSnapshot(fixture().input),pending=await collectFirstHandoffSnapshot(fixture({phase:'pending'}).input),
    committed=await collectFirstHandoffSnapshot(fixture({phase:'committed'}).input);
  for(const key of ['project','handoffEvidence','epochProof','trustedAuthorIds','expectedProjectId']){
    assert.deepEqual(pending[key],initial[key]);assert.deepEqual(committed[key],initial[key]);
  }
});
test('rejects a changed saved comment even if API reports it as unedited',async()=>{
  for(const phase of ['pending','committed']){const f=fixture({phase});
    f.state.comment=f.state.comment.replace('Wykonano: Praca','Wykonano: Inna praca');
    assert.deepEqual(await collectFirstHandoffSnapshot(f.input),{kind:'blocked',reason:'checkpoint-comment-mismatch'});
  }
});
