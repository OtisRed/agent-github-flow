import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const STATES = ['decision-gate','needs-design','audit','spike','agent-ready','review','smoke','done'];
const DEFAULT_STATES = ['Todo','In Progress','Done'];
const SPEC = [
  ['decision-gate','RED','Potrzebna decyzja właściciela'],
  ['needs-design','BLUE','Punkt wejścia Designera; kontrakt do dopracowania'],
  ['audit','ORANGE','Potrzebne ustalenie faktów lub przyczyny'],
  ['spike','PURPLE','Potrzebny ograniczony eksperyment'],
  ['agent-ready','YELLOW','Kontrakt gotowy do wykonania'],
  ['review','PINK','Zmiana wymaga review i kontroli'],
  ['smoke','ORANGE','Wymagany wspólny smoke'],
  ['done','GREEN','Issue zamknięte po decyzji właściciela']
];

export function parseProject(value) {
  const m = /^(user|organization):([A-Za-z0-9-]+)\/([1-9][0-9]*)$/.exec(value || '');
  if (!m || !Number.isSafeInteger(Number(m[3]))) return null;
  return {kind:m[1],login:m[2],number:Number(m[3])};
}

export function assess(project) {
  if (!project?.id || project.closed !== false || project.fields?.pageInfo?.hasNextPage !== false || !Array.isArray(project.fields.nodes) || !Array.isArray(project.views?.nodes)) return {state:'unverified', reason:'incomplete-project'};
  const fields = project.fields.nodes.filter(field => field?.name === 'Status');
  if (fields.length !== 1 || fields[0].__typename !== 'ProjectV2SingleSelectField' || !Array.isArray(fields[0].options) || !fields[0].id) return {state:'conflict',reason:'status-field'};
  const options=fields[0].options.map(option => option?.name);
  if (options.length !== STATES.length || options.some((value,index) => value !== STATES[index])) {
    const defaults=options.length===DEFAULT_STATES.length && options.every((value,index)=>value===DEFAULT_STATES[index]);
    const ids=fields[0].options.map(option=>option?.id);
    if (defaults && project.items?.totalCount === 0 && ids.every(id=>typeof id==='string' && id) && new Set(ids).size===3) {
      const v=project.views.nodes[0];
      return {state:'needs-status',projectId:project.id,fieldId:fields[0].id,options,defaultIds:ids,items:0,viewId:v?.id,number:v?.number,name:v?.name,filter:v?.filter,layout:v?.layout};
    }
    return {state:'conflict',reason:'status-options'};
  }
  const view=project.views.nodes[0];
  if (!view) return {state:'needs-create',projectId:project.id,fieldId:fields[0].id,options};
  if (!view.id || !Number.isInteger(view.number) || typeof view.layout !== 'string' || view.verticalGroupByFields?.pageInfo?.hasNextPage !== false || !Array.isArray(view.verticalGroupByFields.nodes)) return {state:'unverified',reason:'incomplete-view'};
  const snapshot={projectId:project.id,fieldId:fields[0].id,options,viewId:view.id,number:view.number,name:view.name,filter:view.filter,layout:view.layout};
  const groups=view.verticalGroupByFields.nodes;
  if (view.layout === 'BOARD_LAYOUT') {
    if (groups.length === 1 && groups[0]?.id === fields[0].id) return {state:'ok',...snapshot};
    return {state:'manual',reason:'board-group',...snapshot};
  }
  if (view.layout === 'TABLE_LAYOUT') return {state:'needs-layout',...snapshot};
  return {state:'manual',reason:'unsupported-layout',...snapshot};
}

function sameBase(a,b) {
  return a.state === b.state && a.projectId === b.projectId && a.fieldId === b.fieldId && a.viewId === b.viewId && a.number === b.number && a.name === b.name && a.filter === b.filter && a.layout === b.layout && a.items === b.items && JSON.stringify(a.defaultIds) === JSON.stringify(b.defaultIds) && JSON.stringify(a.options) === JSON.stringify(b.options);
}

// A non-successful or timed-out write is never repeated. Re-read and report.
export function ensureBoard(client, {apply=false,initializeEmpty=false}={}) {
  let first=assess(client.read());
  let statusInitialized=false;
  if (first.state === 'needs-status') {
    if (!apply || !initializeEmpty) return {...first,changed:false};
    const check=assess(client.read());
    if (!sameBase(first,check)) return {state:'conflict',reason:'changed-before-write',changed:false};
    const original=first;
    const preserved={'needs-design':first.defaultIds[0],'agent-ready':first.defaultIds[1],done:first.defaultIds[2]};
    const options=SPEC.map(([name,color,description])=>({...preserved[name] && {id:preserved[name]},name,color,description}));
    const sent=client.setStatus(first.fieldId,options);
    first=assess(client.read());
    if (!['ok','needs-layout','needs-create','manual'].includes(first.state) || first.projectId!==original.projectId || first.fieldId!==original.fieldId) return {state:'unverified',reason:sent?'status-readback-mismatch':'status-write-outcome-unknown',changed:null,writeAttempted:true};
    statusInitialized=true;
    if (first.viewId!==original.viewId || first.number!==original.number || first.name!==original.name || first.filter!==original.filter || first.layout!==original.layout) return {state:'conflict',reason:'view-changed-during-status-setup',changed:true,statusInitialized:true};
  }
  if (!['needs-layout','needs-create'].includes(first.state) || !apply) return {...first,changed:statusInitialized,...statusInitialized && {statusInitialized:true}};
  const second=assess(client.read());
  if (!sameBase(first,second)) return {state:'conflict',reason:'changed-before-write',changed:false};
  const sent=first.state === 'needs-layout' ? client.setLayout(first.viewId) : client.createView(first.projectId);
  const after=assess(client.read());
  if (after.state === 'ok' && after.projectId === first.projectId && after.fieldId === first.fieldId && (first.state === 'needs-create' || (after.viewId === first.viewId && after.filter === first.filter && after.name === first.name))) return {state:'ok',changed:true,writeConfirmed:sent === true,number:after.number,...statusInitialized && {statusInitialized:true}};
  return {state:'unverified',reason:sent ? 'readback-mismatch' : 'write-outcome-unknown',changed:null,writeAttempted:true,...statusInitialized && {statusInitialized:true}};
}

function gh(args,input) {
  const result=spawnSync('gh',['api','graphql',...args],{input:input ? JSON.stringify(input) : undefined,encoding:'utf8',timeout:20000,maxBuffer:2*1024*1024,windowsHide:true,env:{...process.env,GH_PROMPT_DISABLED:'1',GH_NO_UPDATE_NOTIFIER:'1'}});
  if (result.error || result.status !== 0) return null;
  try { const data=JSON.parse(result.stdout); return data.errors?.length ? null : data.data; } catch { return null; }
}

export function githubClient(target) {
  const root=target.kind === 'user' ? 'user' : 'organization';
  const query=`query($login:String!,$number:Int!){${root}(login:$login){projectV2(number:$number){id closed repositories(first:100){nodes{nameWithOwner} pageInfo{hasNextPage}} items(first:1,archivedStates:[ARCHIVED,NOT_ARCHIVED]){totalCount} fields(first:100){nodes{__typename ... on ProjectV2Field{id name} ... on ProjectV2SingleSelectField{id name options{id name}}}pageInfo{hasNextPage}} views(first:1,orderBy:{field:POSITION,direction:ASC}){nodes{id number name layout filter verticalGroupByFields(first:10){nodes{__typename ... on ProjectV2Field{id name} ... on ProjectV2SingleSelectField{id name}} pageInfo{hasNextPage}}}}}}}`;
  return {
    read() { return gh(['-f',`query=${query}`,'-f',`login=${target.login}`,'-F',`number=${target.number}`])?.[root]?.projectV2 ?? null; },
    setStatus(id,options) { return !!gh(['--input','-'],{query:'mutation($id:ID!,$options:[ProjectV2SingleSelectFieldOptionInput!]!){updateProjectV2Field(input:{fieldId:$id,singleSelectOptions:$options}){projectV2Field{... on ProjectV2SingleSelectField{id}}}}',variables:{id,options}})?.updateProjectV2Field?.projectV2Field?.id; },
    setLayout(id) { return !!gh(['-f','query=mutation($id:ID!){updateProjectV2View(input:{viewId:$id,layout:BOARD_LAYOUT}){projectV2View{id}}}','-f',`id=${id}`])?.updateProjectV2View?.projectV2View?.id; },
    createView(id) { return !!gh(['-f','query=mutation($id:ID!){createProjectV2View(input:{projectId:$id,name:"Kanban",layout:BOARD_LAYOUT}){projectV2View{id}}}','-f',`id=${id}`])?.createProjectV2View?.projectV2View?.id; }
  };
}

function main(args) {
  const match=args.length >= 2 && args[0] === '--project' ? parseProject(args[1]) : null;
  const switches=args.slice(2);
  if (!match || switches.some(a=>!['--apply','--initialize-empty'].includes(a)) || new Set(switches).size!==switches.length) throw Error('Usage: node project-board.mjs --project user:OWNER/NUMBER [--apply] [--initialize-empty]');
  const result=ensureBoard(githubClient(match),{apply:switches.includes('--apply'),initializeEmpty:switches.includes('--initialize-empty')});
  const {state,reason,number,changed,writeConfirmed,statusInitialized,writeAttempted}=result;
  console.log(JSON.stringify({state,reason,number,changed,writeConfirmed,statusInitialized,writeAttempted,columnsVisible:'unverified'}));
  if (state !== 'ok') process.exitCode=2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode=2; } }
