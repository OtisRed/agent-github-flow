// Detached composition for the first v3 recovery reservation only. The
// supplied cycle, readers, journal, clocks and Git transports must be trusted.
// Optional status and final continuations are detached; tests use synthetic
// transports. This module does not enforce that supplied callbacks are fake.
import {isDeepStrictEqual} from 'node:util';
import {observeIngressDelivery} from './ingress-observation.mjs';
import {matchesFinalContext} from './worker-final-context.mjs';

export async function runGuardedReservation(input={}){
  try{
    const {routes,graphql,keyring,resolvePolicy,runCycle,cycleInput,signer,createPublicationStep,publicationInputs,deriveBinding,journal,
      createStatusStep,statusInputs,finalInputs}=input;
    const state=structuredClone(input.state),delivery=structuredClone(input.delivery),stable=structuredClone(input.metadata);
    const commitment=structuredClone(input.commitment);
    if(!state||state.kind!=='recovering'||state.refIntent!==0||state.statusIntent!==1
        ||!delivery||state.deliveryId!==delivery.deliveryId||stable?.deliveryId!==delivery.deliveryId
        ||!signer||typeof signer.verify!=='function'||typeof signer.transition!=='function'||typeof signer.verifyTransition!=='function'
        ||!signer.verify(stable,commitment)||typeof resolvePolicy!=='function'||typeof runCycle!=='function'
        ||typeof createPublicationStep!=='function'||typeof deriveBinding!=='function'
        ||!cycleInput||typeof cycleInput.wait!=='function'||typeof cycleInput.collectContext!=='function'||keyring!==cycleInput.keyring
        ||!publicationInputs||typeof publicationInputs.publish!=='function'||typeof publicationInputs.verifyProtection!=='function'
        ||publicationInputs.collectContext!==cycleInput.collectContext
        ||typeof journal?.record!=='function'||typeof journal?.read!=='function'||typeof journal?.confirm!=='function')return {kind:'blocked'};
    const cycle={...cycleInput,policy:structuredClone(cycleInput.policy),
      projectRegistration:structuredClone(cycleInput.projectRegistration),registrationCommitment:structuredClone(cycleInput.registrationCommitment)};
    const rawCollect=cycle.collectContext;
    const mappingMatches=(project,options)=>{
      if(!Array.isArray(options))return false;
      const source=options.filter(x=>x?.name===stable.binding.fromStatus);
      const target=options.filter(x=>x?.name===stable.binding.targetStatus);
      return source.length===1&&target.length===1&&source[0].id===stable.fromOptionId&&target[0].id===stable.targetOptionId;
    };
    let statusSent=false,statusAcknowledged=false;
    const guardedCollect=async()=>{
      const context=structuredClone(await rawCollect()),project=context?.observation?.project;
      const source=project?.currentStatus===stable.binding.fromStatus&&project?.statusOptionId===stable.fromOptionId;
      const target=project?.currentStatus===stable.binding.targetStatus&&project?.statusOptionId===stable.targetOptionId;
      if(!project||project.kind!=='branch-project-observed'||project.issueState!=='OPEN'
          ||project.itemId!==stable.itemId||(!source&&!(statusAcknowledged&&target))||!mappingMatches(project,project.statusOptions)
          ||!mappingMatches(project,cycle.projectRegistration.statusOptions))throw Error('project-binding-mismatch');
      return context;
    };
    const verifiedCollect=async expected=>{
      const context=await guardedCollect(),observation=context?.observation;
      const checkpoint=observation?.checkpoint,handoff=observation?.handoffEvidence?.handoff;
      const current=deriveBinding(structuredClone(cycle.policy),structuredClone(checkpoint?.selectedRecord),checkpoint?.headOid);
      if(!isDeepStrictEqual(current,expected)||handoff?.kind!=='handoff'||handoff.id!==expected.commentId
          ||handoff.createdAt!==expected.createdAt||!expected.trustedAuthorIds.includes(handoff.authorId)
          ||!keyring.forId(expected.commentKeyId).verifyComment({repositoryId:expected.repositoryId,
            issueId:expected.issueId,commentId:expected.commentId,body:handoff.body},expected.commentMac)
          ||!keyring.forId(expected.configKeyId).verifyConfig(cycle.projectRegistration,expected.configMac))
        throw Error('handoff-binding-mismatch');
      return context;
    };
    cycle.collectContext=guardedCollect;
    const publication={...publicationInputs,policy:cycle.policy,projectRegistration:cycle.projectRegistration,
      registrationCommitment:cycle.registrationCommitment,keyring,collectContext:guardedCollect};
    const protectionVerified=async()=>{
      const value=await publication.verifyProtection();
      return value?.kind==='checkpoint-protection-observed'&&value.repositoryId===cycle.policy.repositoryId
        &&value.appId===cycle.policy.appId&&value.updateRulesetId===cycle.policy.updateRulesetId
        &&value.historyRulesetId===cycle.policy.historyRulesetId;
    };
    const record=journal.record.bind(journal),read=journal.read.bind(journal),confirm=journal.confirm.bind(journal);
    let resolved=null,registration=null,commitmentUsed=null;
    const route=await observeIngressDelivery({delivery,routes,graphql,keyring,resolvePolicy:async args=>{
      registration=args.registration;commitmentUsed=args.registrationCommitment;
      resolved=await resolvePolicy(args);return resolved;
    }});
    if(route.kind!=='observed'||!isDeepStrictEqual(resolved?.policy,cycle.policy)
        ||!isDeepStrictEqual(registration,cycle.projectRegistration)
        ||!isDeepStrictEqual(commitmentUsed,cycle.registrationCommitment))return {kind:'blocked'};
    let waited=false,attempted=false,recorded=null,confirmed=false,statusCalls=0,statusObserved=false,approvedBinding=null;
    let statusContext=null,finalAttempted=false,finalCompleted=false;
    async function runFinal(args){
      if(finalAttempted||!statusObserved||!confirmed||args?.operation!=='commit'
          ||!isDeepStrictEqual(args.expectedBinding,approvedBinding)||!finalInputs
          ||typeof finalInputs.encode!=='function'||typeof finalInputs.verifyContinuity!=='function'
          ||typeof signer.completion!=='function'||typeof signer.verifyCompletion!=='function'
          ||typeof journal.recordFinal!=='function'||typeof journal.finalize!=='function'
          ||typeof publication.observe!=='function')return {kind:'blocked'};
      finalAttempted=true;
      const encode=finalInputs.encode,verifyContinuity=finalInputs.verifyContinuity;
      const recordFinal=journal.recordFinal.bind(journal),finalize=journal.finalize.bind(journal),matchesStatus=journal.matchesStatus.bind(journal);
      const publish=publication.publish,observe=publication.observe;
      const metadata=structuredClone(stable);metadata.binding=structuredClone(approvedBinding);
      const commitment={kind:'worker-status-commitment',keyId:recorded.keyId,mac:recorded.nextMac};
      if(!signer.verify(metadata,commitment)||(await matchesStatus(delivery.deliveryId,structuredClone(commitment)))?.kind!=='matched'
          ||!isDeepStrictEqual(statusContext,await verifiedCollect(approvedBinding))||!await protectionVerified()
          ||!isDeepStrictEqual(statusContext,await verifiedCollect(approvedBinding)))return {kind:'blocked'};
      const before=structuredClone(statusContext),expectedRecord=structuredClone(before.observation.checkpoint.selectedRecord);
      expectedRecord.current.phase='committed';expectedRecord.reservation=null;
      let proposed=null,publishStarted=false,publishAcknowledged=false,observed=false;
      const guardedPublish=async payload=>{
        if(publishStarted)return {kind:'blocked'};publishStarted=true;
        const safePayload=structuredClone(payload);
        const oldOid=safePayload?.expectedHeadOid,newOid=safePayload?.commit?.sha,treeOid=safePayload?.expectedTreeOid;
        if(oldOid!==approvedBinding.checkpointOid||!isDeepStrictEqual(safePayload.after,expectedRecord)
            ||safePayload.commit?.tree?.sha!==treeOid||!Array.isArray(safePayload.commit?.parents)
            ||safePayload.commit.parents.length!==1||safePayload.commit.parents[0]?.sha!==oldOid)return {kind:'blocked'};
        const encoded=encode(structuredClone(expectedRecord));
        if(encoded?.kind!=='encoded-record'||verifyContinuity(structuredClone(before.observation.checkpoint.selectedRecord),
            structuredClone(expectedRecord))?.kind!=='continuity-verified')return {kind:'blocked'};
        const plan={metadata,oldOid,newOid,treeOid,recordContent:encoded.content};
        const transition=signer.completion(plan);
        if(transition.kind!=='worker-final-ref-transition'||!signer.verifyCompletion(plan,transition)
            ||(await matchesStatus(delivery.deliveryId,structuredClone(commitment)))?.kind!=='matched'
            ||!isDeepStrictEqual(before,await verifiedCollect(approvedBinding)))return {kind:'blocked'};
        if((await recordFinal(delivery.deliveryId,structuredClone(transition)))?.kind!=='recorded')return {kind:'blocked'};
        if(!isDeepStrictEqual(await read(delivery.deliveryId),transition)||!signer.verifyCompletion(plan,transition)
            ||!isDeepStrictEqual(before,await verifiedCollect(approvedBinding))||!await protectionVerified()
            ||!isDeepStrictEqual(before,await verifiedCollect(approvedBinding)))return {kind:'blocked'};
        proposed={plan,transition};
        const result=await publish(structuredClone(safePayload));
        publishAcknowledged=result?.kind==='ref-update-acknowledged';
        return result;
      };
      const guardedObserve=async input=>{
        const safe=structuredClone(input);
        if(observed||!proposed||!isDeepStrictEqual(safe,{oldOid:proposed.plan.oldOid,newOid:proposed.plan.newOid,
          expectedTreeOid:proposed.plan.treeOid}))return {kind:'blocked'};
        const result=await observe(safe);observed=result?.kind==='publication-observed';return result;
      };
      const step=createPublicationStep({...publication,publish:guardedPublish,observe:guardedObserve});
      const result=await step(args);
      if(!proposed||!publishStarted||!publishAcknowledged||!observed||result?.kind!=='v3-commit-observed'
          ||!signer.verifyCompletion(proposed.plan,proposed.transition)
          ||!isDeepStrictEqual(await read(delivery.deliveryId),proposed.transition))return {kind:'blocked'};
      const after=await guardedCollect();
      const comparison={before,after,receipt:result.receipt,oldOid:proposed.plan.oldOid,newOid:proposed.plan.newOid,
        itemId:stable.itemId,targetOptionId:stable.targetOptionId,encode,verifyContinuity};
      if(!matchesFinalContext(comparison)||!await protectionVerified()
          ||!isDeepStrictEqual(after,await guardedCollect())||!matchesFinalContext(comparison))return {kind:'blocked'};
      if((await finalize(delivery.deliveryId,structuredClone(proposed.transition)))?.kind!=='confirmed')return {kind:'blocked'};
      finalCompleted=true;
      return result;
    }
    const makePublicationStep=()=>async args=>{
      if(attempted&&args?.operation==='commit')return runFinal(args);
      if(attempted||!waited||args?.operation!=='reservation'||!isDeepStrictEqual(args.expectedBinding,stable.binding))return {kind:'blocked'};
      attempted=true;let proposed=null,expectedBinding=null,publishStarted=false,authorId=null;
      const guardedPublish=async payload=>{
        if(publishStarted)return {kind:'blocked'};
        publishStarted=true;
        const safePayload=structuredClone(payload);
        const oldOid=safePayload?.expectedHeadOid,newOid=safePayload?.commit?.sha,treeOid=safePayload?.expectedTreeOid;
        const reservedAt=safePayload?.after?.reservation?.reservedAt;
        const plan={metadata:stable,oldOid,newOid,treeOid,reservedAt};
        const transition=signer.transition(plan);
        if(transition.kind!=='worker-ref-transition'||safePayload.commit?.tree?.sha!==treeOid
            ||!Array.isArray(safePayload.commit?.parents)||safePayload.commit.parents.length!==1
            ||safePayload.commit.parents[0]?.sha!==oldOid)return {kind:'blocked'};
        const expected=structuredClone(stable.binding);
        expected.checkpointOid=newOid;expected.reservation.reservedAt=reservedAt;
        if(!isDeepStrictEqual(deriveBinding(structuredClone(cycle.policy),structuredClone(safePayload.after),newOid),expected))return {kind:'blocked'};
        const beforeRecord=await verifiedCollect(stable.binding);
        authorId=beforeRecord.observation.handoffEvidence.handoff.authorId;
        if((await record(delivery.deliveryId,structuredClone(transition)))?.kind!=='recorded')return {kind:'blocked'};
        const persisted=await read(delivery.deliveryId);
        if(!isDeepStrictEqual(persisted,transition)||!signer.verifyTransition(plan,persisted))return {kind:'blocked'};
        if(!isDeepStrictEqual(beforeRecord,await verifiedCollect(stable.binding))||!await protectionVerified()
            ||!isDeepStrictEqual(beforeRecord,await verifiedCollect(stable.binding)))return {kind:'blocked'};
        proposed={plan,transition};expectedBinding=expected;recorded=transition;
        return publication.publish(structuredClone(safePayload));
      };
      const step=createPublicationStep({...publication,publish:guardedPublish});
      const result=await step(args);
      if(!proposed||result?.kind!=='v3-reservation-observed'||!isDeepStrictEqual(result.binding,expectedBinding)
          ||!signer.verifyTransition(proposed.plan,proposed.transition))return {kind:'blocked'};
      const finalContext=await verifiedCollect(expectedBinding);
      if(finalContext.observation.handoffEvidence.handoff.authorId!==authorId)return {kind:'blocked'};
      const newMetadata=structuredClone(stable);newMetadata.binding=expectedBinding;
      if(!signer.verify(newMetadata,{kind:'worker-status-commitment',keyId:proposed.transition.keyId,mac:proposed.transition.nextMac}))return {kind:'blocked'};
      if(!isDeepStrictEqual(await read(delivery.deliveryId),proposed.transition)||!await protectionVerified()
          ||!isDeepStrictEqual(finalContext,await verifiedCollect(expectedBinding)))return {kind:'blocked'};
      if((await confirm(delivery.deliveryId,structuredClone(proposed.transition)))?.kind!=='confirmed')return {kind:'blocked'};
      confirmed=true;
      approvedBinding=structuredClone(expectedBinding);
      return result;
    };
    const makeStatusStep=()=>async args=>{
      statusCalls++;
      const statusTransport=statusInputs?.transport,statusWrite=statusTransport?.setStatus;
      if(statusCalls!==1||!confirmed||!recorded||!isDeepStrictEqual(args?.expectedBinding,approvedBinding)
          ||typeof createStatusStep!=='function'||!statusInputs||typeof statusWrite!=='function'||typeof journal.matchesStatus!=='function'
          ||statusInputs.collectContext!==cycleInput.collectContext||statusInputs.verifyProtection!==publicationInputs.verifyProtection
          ||statusTransport.projectId!==cycle.policy.projectId||statusTransport.statusFieldId!==cycle.policy.statusFieldId)
        return {kind:'blocked'};
      const metadata=structuredClone(stable);metadata.binding=approvedBinding;
      const nextCommitment={kind:'worker-status-commitment',keyId:recorded.keyId,mac:recorded.nextMac};
      if(!signer.verify(metadata,nextCommitment)||(await journal.matchesStatus(delivery.deliveryId,structuredClone(nextCommitment)))?.kind!=='matched')return {kind:'blocked'};
      const context=await verifiedCollect(approvedBinding);
      if(!await protectionVerified()||!isDeepStrictEqual(context,await verifiedCollect(approvedBinding)))return {kind:'blocked'};
      const transport={projectId:cycle.policy.projectId,statusFieldId:cycle.policy.statusFieldId,setStatus:async values=>{
        const safeValues=structuredClone(values);
        if(statusSent||safeValues?.itemId!==stable.itemId||safeValues?.targetOptionId!==stable.targetOptionId)return {kind:'blocked'};
        if((await journal.matchesStatus(delivery.deliveryId,structuredClone(nextCommitment)))?.kind!=='matched'
            ||!isDeepStrictEqual(context,await verifiedCollect(approvedBinding))||!await protectionVerified()
            ||!isDeepStrictEqual(context,await verifiedCollect(approvedBinding)))return {kind:'blocked'};
        statusSent=true;
        const result=await statusWrite.call(statusTransport,safeValues);
        statusAcknowledged=result?.kind==='status-write-acknowledged';
        return result;
      }};
      const step=createStatusStep({...statusInputs,policy:cycle.policy,projectRegistration:cycle.projectRegistration,
        registrationCommitment:cycle.registrationCommitment,keyring,collectContext:guardedCollect,transport});
      const result=await step(args);
      if(!statusSent||!statusAcknowledged||result?.kind!=='status-target-observed'
          ||!isDeepStrictEqual(result.binding,approvedBinding))return {kind:'blocked'};
      const after=await verifiedCollect(approvedBinding),normalized=structuredClone(after);
      if(after.observation.project.currentStatus!==stable.binding.targetStatus
          ||after.observation.project.statusOptionId!==stable.targetOptionId)return {kind:'blocked'};
      normalized.observation.project.currentStatus=stable.binding.fromStatus;
      normalized.observation.project.statusOptionId=stable.fromOptionId;
      if(!isDeepStrictEqual(context,normalized)||!await protectionVerified()
          ||!isDeepStrictEqual(after,await verifiedCollect(approvedBinding)))return {kind:'blocked'};
      statusObserved=true;
      statusContext=structuredClone(after);
      return result;
    };
    const result=await runCycle({...cycle,
      wait:async ms=>{if(ms!==120000)throw Error('unexpected-wait');await cycle.wait(ms);waited=true;},
      makePublicationStep,makeStatusStep});
    if(result?.kind==='first-v3-handoff-observed'&&finalCompleted&&statusObserved)return {kind:'final-observed-completed'};
    if(!finalAttempted&&result?.kind==='v3-cycle-stopped'&&result.phase==='commit'&&confirmed&&recorded&&statusObserved&&statusCalls===1)
      return {kind:'status-observed-commit-blocked'};
    return typeof createStatusStep!=='function'&&result?.kind==='v3-cycle-stopped'&&result.phase==='status'&&confirmed&&recorded&&statusCalls===1
      ?{kind:'reservation-observed-status-blocked'}:{kind:'blocked'};
  }catch{return {kind:'blocked'};}
}
