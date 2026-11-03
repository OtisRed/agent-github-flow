import { isDeepStrictEqual } from 'node:util';
import { auditCheckpointProtection } from './flow-checkpoint-protection-audit.mjs';
import { CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF } from './flow-checkpoint-registration.mjs';

const positive = value => Number.isSafeInteger(value) && value > 0;
const blocked = reason => ({ kind: 'blocked', reason });

// Link URLs are never followed. Only a same-endpoint page number is extracted
// and the next URL is reconstructed locally. Unexpected pagination fails shut.
function nextPage(link, path, current) {
  if (link === null || link === '') return null;
  if (typeof link !== 'string' || link.length > 8192) throw Error('invalid-link');
  let next = null;
  for (const part of link.split(/,\s*(?=<)/)) {
    const match = part.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/);
    if (!match) throw Error('invalid-link');
    if (match[2] !== 'next') continue;
    if (next !== null) throw Error('invalid-link');
    let url; try { url = new URL(match[1]); } catch { throw Error('invalid-link'); }
    let pathname; try { pathname = decodeURIComponent(url.pathname); } catch { throw Error('invalid-link'); }
    if (url.protocol !== 'https:' || url.hostname !== 'api.github.com' || url.port || url.username || url.password
        || url.hash || pathname !== decodeURIComponent(path)) throw Error('invalid-link');
    const params = [...url.searchParams.keys()];
    const pages = url.searchParams.getAll('page'); const sizes = url.searchParams.getAll('per_page');
    if (params.length !== 2 || pages.length !== 1 || sizes.length !== 1 || sizes[0] !== '100'
        || pages[0] !== String(current + 1)) throw Error('invalid-link');
    next = current + 1;
  }
  return next;
}

// Read-only authorized audit. request must be a trusted authenticated
// GET-only transport that limits response size and returns status/json/headers.
// It must see bypass_actors; App metadata-only access omits that field.
// Config and App identity are externally trusted. No result authorizes a write.
export async function readCheckpointProtectionAudit(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || !/^[A-Za-z0-9-]{1,39}$/.test(input.owner ?? '') || !/^[A-Za-z0-9_.-]{1,100}$/.test(input.repo ?? '')
      || ['.', '..'].includes(input.repo) || typeof input.repositoryId !== 'string' || !input.repositoryId
      || !positive(input.appId) || !positive(input.updateRulesetId) || !positive(input.historyRulesetId)
      || input.updateRulesetId === input.historyRulesetId || typeof input.expectedPrivate !== 'boolean'
      || typeof input.request !== 'function') return blocked('invalid-input');
  const { owner, repo, repositoryId, appId, updateRulesetId, historyRulesetId, expectedPrivate, request } = input;
  const basePath = `/repos/${owner}/${repo}`; const base = `https://api.github.com${basePath}`;
  async function get(url) {
    const response = await request(url);
    if (!response || response.status !== 200 || typeof response.json !== 'function' || typeof response.headers?.get !== 'function') throw Error('read-failed');
    return { data: structuredClone(await response.json()), link: response.headers.get('link') };
  }
  async function readRules(ref) {
    const branch = ref.slice('refs/heads/'.length);
    const path = `${basePath}/rules/branches/${encodeURIComponent(branch)}`;
    const pages = []; let page = 1;
    while (page <= 100) {
      const result = await get(`https://api.github.com${path}?per_page=100&page=${page}`);
      if (!Array.isArray(result.data) || result.data.length > 100) throw Error('invalid-page');
      pages.push(result.data);
      const next = nextPage(result.link, path, page);
      if (next === null) return pages;
      page = next;
    }
    throw Error('page-limit');
  }
  async function observe() {
    const repository = (await get(base)).data;
    const repositoryData = { node_id: repository?.node_id, full_name: repository?.full_name,
      private: repository?.private, fork: repository?.fork, default_branch: repository?.default_branch };
    const updateRuleset = (await get(`${base}/rulesets/${updateRulesetId}`)).data;
    const historyRuleset = (await get(`${base}/rulesets/${historyRulesetId}`)).data;
    if (updateRuleset?.id !== updateRulesetId || historyRuleset?.id !== historyRulesetId) throw Error('ruleset-mismatch');
    const refs = [CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF];
    const effective = [];
    for (const ref of refs) effective.push({ ref, pages: await readRules(ref) });
    return { repositoryData, updateRuleset, historyRuleset, effective };
  }
  try {
    const first = await observe(); const second = await observe();
    if (!isDeepStrictEqual(first, second)) return blocked('protection-observation-changed');
    return auditCheckpointProtection({ repositoryId, repository: `${owner}/${repo}`, appId, expectedPrivate,
      repositoryData: first.repositoryData, updateRuleset: first.updateRuleset, historyRuleset: first.historyRuleset,
      effective: first.effective.map(item => ({ ref: item.ref, rules: item.pages.flat() })) });
  } catch { return blocked('protection-read-unavailable'); }
}
