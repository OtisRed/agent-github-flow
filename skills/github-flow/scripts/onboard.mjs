import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {diagnose,parseProjectArgument} from './diagnose.mjs';
import {ensureBoard,githubClient,parseProject} from './project-board.mjs';
import {ensureSmoke,githubRepositoryClient} from './repo-branch.mjs';

export function prepare({repo,project,apply=false,initializeEmpty=false,createSmoke=false},{diagnostic=diagnose,board=ensureBoard,branch=ensureSmoke,makeClient=githubClient,makeRepoClient=githubRepositoryClient,now=()=>Date.now()}={}) {
 const start=now();
 const parsed=parseProject(project), diagnosticProject=parseProjectArgument(project);
 if (!repo || !parsed || !diagnosticProject) throw Error('A repository path and valid Project identity are required.');
 const report=diagnostic(repo,true,diagnosticProject);
 const checks=Object.fromEntries((report.checks??[]).map(({id,state})=>[id,state]));
 const blockers=['repository','remote-identity','github-live','explicit-project','github-project'].filter(id=>checks[id]!=='ok');
 const identity=report.inventory?.githubRepository;
 if (!identity?.owner || !identity?.repo) blockers.push('repository-identity');
 let projectLink='unverified';
 let view={state:'blocked',reason:'diagnostic-incomplete',changed:false};
 let smokeBranch={state:'blocked',reason:'diagnostic-incomplete',changed:false};
 if (blockers.length===0) {
   const boardClient=makeClient(parsed);
   const repos=boardClient.read()?.repositories;
   if(repos?.pageInfo?.hasNextPage===false && Array.isArray(repos.nodes) && repos.nodes.some(r=>r?.nameWithOwner?.toLowerCase()===`${identity.owner}/${identity.repo}`.toLowerCase())) projectLink='ok';
   else blockers.push('project-repository-link-unverified');
   if(projectLink==='ok') {
   const branchResult=branch(makeRepoClient(identity),identity,{apply:apply && createSmoke});
   const {state,reason,changed,writeConfirmed,writeAttempted}=branchResult;
   smokeBranch={state,reason,changed,writeConfirmed,writeAttempted};
   if (!['conflict','unverified'].includes(state)) {
     const result=board(boardClient,{apply,initializeEmpty});
     const {state:viewState,reason:viewReason,number,changed:viewChanged,writeConfirmed:viewConfirmed,statusInitialized,writeAttempted:viewAttempted}=result;
     view={state:viewState,reason:viewReason,number,changed:viewChanged,writeConfirmed:viewConfirmed,statusInitialized,writeAttempted:viewAttempted,columnsVisible:'unverified'};
   } else view={state:'blocked',reason:'branch-outcome-unverified',changed:false};
   }
 }
 return {
   ready:false,
   state:'partial',
   durationMs:Math.max(0,now()-start),
   diagnostic:{checks,projectLink,blockers},
   smokeBranch,
   firstView:view,
   remaining:['visible-kanban-columns-check','app-installation-access','project-auto-add-and-status-writers','repository-instructions-ci-and-protection','controller-enrollment-and-promotion','actual-issue-pr-and-owner-smoke'],
   limitation:'This helper inventories existing configuration and can prepare the smoke branch and first Project view; it does not establish or verify the remaining onboarding stages.'
 };
}
function main(args) {
 let repo,project,apply=false,initializeEmpty=false,createSmoke=false;
 for(let i=0;i<args.length;i++) {
   if(args[i]==='--repo' && args[i+1] && !repo) repo=args[++i];
   else if(args[i]==='--project' && args[i+1] && !project) project=args[++i];
   else if(args[i]==='--apply' && !apply) apply=true;
   else if(args[i]==='--initialize-empty' && !initializeEmpty) initializeEmpty=true;
   else if(args[i]==='--create-smoke' && !createSmoke) createSmoke=true;
   else throw Error('Usage: node onboard.mjs --repo PATH --project user:OWNER/NUMBER [--apply] [--initialize-empty] [--create-smoke]');
 }
 const result=prepare({repo,project,apply,initializeEmpty,createSmoke});
 console.log(JSON.stringify(result,null,2));
 // A successful board check is not a completed onboarding or product gate.
 if(!result.ready)process.exitCode=2;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{main(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=2;}}
