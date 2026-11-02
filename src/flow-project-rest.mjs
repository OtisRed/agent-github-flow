const nonempty = value => typeof value === 'string' && value.length > 0;
const validCursor = value => nonempty(value) && value.length <= 2048 && !/[\x00-\x1f\x7f]/.test(value);

function nextCursorFromLink(header, owner, number) {
  if (header === null || header === '') return null;
  if (typeof header !== 'string') throw Error('invalid-link');
  let next = null;
  for (const part of header.split(/,\s*(?=<)/)) {
    const match = part.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/);
    if (!match) throw Error('invalid-link');
    if (match[2] !== 'next') continue;
    if (next !== null) throw Error('invalid-link');
    let url; try { url = new URL(match[1]); } catch { throw Error('invalid-link'); }
    const ownerPath = `/users/${owner}/projectsV2/${number}/items`;
    const canonicalPath = new RegExp(`^/user/[0-9]+/projectsV2/${number}/items$`);
    if (url.protocol !== 'https:' || url.hostname !== 'api.github.com' || url.port || url.username || url.password
      || (url.pathname !== ownerPath && !canonicalPath.test(url.pathname)) || url.hash) throw Error('invalid-link');
    const values = url.searchParams.getAll('after');
    if (values.length !== 1 || !validCursor(values[0])) throw Error('invalid-link');
    next = values[0];
  }
  return next;
}

// request is an authenticated GET transport supplied by the caller. Only a
// freshly constructed api.github.com URL is requested; Link URLs are never
// followed, and their validated cursor is used only as a query parameter.
export function createProjectItemsReader({ request }) {
  if (typeof request !== 'function') throw Error('invalid-request');
  return async ({ owner, projectNumber, after }) => {
    if (!/^[A-Za-z0-9-]{1,39}$/.test(owner ?? '') || !Number.isSafeInteger(projectNumber) || projectNumber < 1
      || !(after === null || validCursor(after))) throw Error('invalid-input');
    const url = new URL(`https://api.github.com/users/${owner}/projectsV2/${projectNumber}/items`);
    url.searchParams.set('per_page', '100');
    if (after !== null) url.searchParams.set('after', after);
    const response = await request(url.toString());
    if (!response || response.status !== 200 || typeof response.json !== 'function'
      || typeof response.headers?.get !== 'function') throw Error('request-failed');
    const data = await response.json();
    if (!Array.isArray(data) || data.length > 100) throw Error('invalid-page');
    const items = data.map(item => {
      if (!item || !nonempty(item.node_id) || !['Issue', 'PullRequest', 'DraftIssue'].includes(item.content_type)
        || !(item.archived_at === null || nonempty(item.archived_at))) throw Error('invalid-item');
      return { nodeId: item.node_id, contentNodeId: item.content?.node_id ?? null,
        contentType: item.content_type, archived: item.archived_at !== null };
    });
    return { items, nextCursor: nextCursorFromLink(response.headers.get('link'), owner, projectNumber) };
  };
}
