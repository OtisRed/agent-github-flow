// Local-only bridge. Every process gets a fresh synthetic catalog and profile directory.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const root = dirname(fileURLToPath(import.meta.url));
// Chef's test fixture supports copying CHEF_TEST_DB; never permit that here.
if (process.env.CHEF_TEST_DB !== undefined) throw new Error('Chef-test refuses CHEF_TEST_DB: only synthetic fixtures are allowed.');
const manifest = JSON.parse(readFileSync(join(root, 'chef-test-source.json'), 'utf8'));
for (const [file, expected] of Object.entries(manifest.files)) {
  const actual = createHash('sha256').update(readFileSync(join(root, file))).digest('hex');
  if (actual !== expected) throw new Error(`Chef-test source mismatch: ${file}`);
}
// Load the selected Chef sources only after checking the saved manifest.
const { createFixture } = await import('./test-support/fixture.js');
const { openWritableCatalog } = await import('./src/write-catalog.js');
const { migrateMealSchema } = await import('./src/meal-schema.js');
const { migratePortionReviewSchema } = await import('./src/portion-review-schema.js');
const { migrateMealComplexitySchema } = await import('./src/meal-complexity-schema.js');
const { migrateAliasSchema } = await import('./src/alias-schema.js');
const { createApp } = await import('./src/server.js');
const runDir = mkdtempSync(join(tmpdir(), 'agf-chef-test-'));
const dbPath = join(runDir, 'synthetic.sqlite');
const profiles = join(runDir, 'profiles');
mkdirSync(profiles);
for (const osoba of ['krzysztof', 'eliza']) {
  const cele = Object.fromEntries(['kcal','bialko_g','tluszcz_g','weglowodany_g'].map(key => [key,{min:1,max:2}]));
  const sekcje = {dane_i_cel:{tresc:'Dane fikcyjne'},kalorie_i_makroskladniki:{status:'aktualne',zrodlo_i_data:'Dane fikcyjne',cele},aktywnosc_i_tryb_zycia:{tresc:'Dane fikcyjne'},ograniczenia_i_zalecenia:{tresc:'Dane fikcyjne'},preferencje_i_organizacja:{tresc:'Dane fikcyjne'}};
  writeFileSync(join(profiles, `${osoba}.json`), JSON.stringify({wersja_formatu:1,osoba,ostatni_pelny_przeglad:'2020-01-01',sekcje}));
}
createFixture(dbPath);
const db = openWritableCatalog(dbPath);
for (const migrate of [migrateMealSchema, migratePortionReviewSchema, migrateMealComplexitySchema, migrateAliasSchema]) migrate(db);
const http = createApp({catalog: db, demo: true, allowWrite: true, profileDir: profiles}).listen(0, '127.0.0.1');
await new Promise((resolve, reject) => { http.once('listening', resolve); http.once('error', reject); });
const client = new Client({name:'chef-test-bridge', version:'0.1.0'});
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`)));
const server = new Server({name:'chef-test', version:'0.1.0'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const result = await client.listTools();
  return {tools:[{name:'chef_test_srodowisko', description:'Identyfikuje wyłącznie lokalny Chef-test i jego wersję.', inputSchema:{type:'object', properties:{}, additionalProperties:false}, annotations:{readOnlyHint:true}}, ...result.tools.map(tool => ({...tool, description:`[CHEF-TEST: dane fikcyjne] ${tool.description ?? ''}`}))]};
});
server.setRequestHandler(CallToolRequestSchema, async ({params}) => {
  if (params.name === 'chef_test_srodowisko') return {content:[{type:'text', text:JSON.stringify({srodowisko:'chef-test', dane:'syntetyczne', commit_zrodla:manifest.commit, integralnosc:'zgodna z manifestem pilota', przechowywanie:'oddzielny katalog i baza dla każdego uruchomienia'})}]};
  return client.callTool({name:params.name, arguments:params.arguments ?? {}});
});
const transport = new StdioServerTransport();
transport.onclose = () => { void client.close().finally(() => { http.close(); db.close(); }); };
await server.connect(transport);
