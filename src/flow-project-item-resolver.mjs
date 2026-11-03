const blocked=reason=>({kind:'blocked',reason});
const id=value=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value;

// Read-only selection from the authenticated Project REST transport. The
// complete list and every page are checked twice; transport must bound the
// response body before JSON parsing. This does not authorize a mutation, prove
// the App identity, or lock the card. Never log item IDs.
export async function resolveProjectIssueItem({owner,projectNumber,issueId,listItems}={}) {
  if(!/^[A-Za-z0-9-]{1,39}$/.test(owner??'')||!Number.isSafeInteger(projectNumber)||projectNumber<1
      ||!id(issueId)||typeof listItems!=='function')return blocked('invalid-input');
  const pages=[],items=[],cursors=new Set();let after=null,size=0;
  const fetchPage=async cursor=>{
    const page=await listItems({owner,projectNumber,after:cursor});
    if(!page||!Array.isArray(page.items)||page.items.length>100||(page.nextCursor!==null&&!id(page.nextCursor)))throw Error('invalid-page');
    for(const item of page.items)if(!item||!id(item.nodeId)||typeof item.archived!=='boolean'
      ||!['Issue','PullRequest','DraftIssue'].includes(item.contentType)||(!item.archived&&!id(item.contentNodeId)))throw Error('invalid-page');
    return {items:page.items.map(item=>({nodeId:item.nodeId,archived:item.archived,contentType:item.contentType,
      contentNodeId:item.archived?null:item.contentNodeId})),nextCursor:page.nextCursor};
  };
  try{
    for(let n=0;n<100;n++){
      const page=await fetchPage(after),serialized=JSON.stringify(page);size+=Buffer.byteLength(serialized,'utf8');
      if(size>8000000)return blocked('size-limit');
      pages.push({after,serialized});items.push(...page.items);
      if(page.nextCursor===null){
        if(new Set(items.map(x=>x.nodeId)).size!==items.length)return blocked('duplicate-card');
        const matched=items.filter(x=>!x.archived&&x.contentType==='Issue'&&x.contentNodeId===issueId);
        if(matched.length!==1)return blocked('ambiguous-card');
        for(const page of pages)if(JSON.stringify(await fetchPage(page.after))!==page.serialized)return blocked('snapshot-changed');
        return {kind:'project-item-observed',issueId,itemId:matched[0].nodeId};
      }
      if(cursors.has(page.nextCursor))return blocked('invalid-cursor');
      cursors.add(page.nextCursor);after=page.nextCursor;
    }
    return blocked('page-limit');
  }catch{return blocked('project-items-unavailable');}
}
