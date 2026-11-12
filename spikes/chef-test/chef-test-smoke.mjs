import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const denied = spawnSync(process.execPath,['--experimental-sqlite','chef-test.mjs'],{cwd:process.cwd(),env:{...process.env,CHEF_TEST_DB:'synthetic-sentinel-do-not-open'},encoding:'utf8'});
assert.notEqual(denied.status, 0);
assert.match(denied.stderr, /only synthetic fixtures are allowed/);
const client = new Client({name:'agf-local-smoke',version:'0.1.0'});
await client.connect(new StdioClientTransport({command:process.execPath,args:['--experimental-sqlite','chef-test.mjs'],cwd:process.cwd(),stderr:'pipe'}));
try {
  const {tools} = await client.listTools();
  assert.ok(tools.some(t => t.name === 'chef_test_srodowisko'));
  assert.ok(tools.some(t => t.name === 'edytuj_produkt'));
  const info = JSON.parse((await client.callTool({name:'chef_test_srodowisko',arguments:{}})).content[0].text);
  assert.equal(info.srodowisko, 'chef-test');
  assert.equal(info.commit_zrodla, JSON.parse(readFileSync('chef-test-source.json','utf8')).commit);
  const item = await client.callTool({name:'pobierz_produkt',arguments:{id:1}});
  const edit = await client.callTool({name:'edytuj_produkt',arguments:{id:1,wersja:item.structuredContent.wersja,zmiany:{nazwa_handlowa:'Fikcyjny produkt testowy'},autor:'Test',komentarz:'Test izolacji'}});
  assert.equal(edit.structuredContent.produkt.nazwa_handlowa, 'Fikcyjny produkt testowy');
  assert.equal((await client.callTool({name:'pobierz_produkt',arguments:{id:1}})).structuredContent.produkt.nazwa_handlowa, 'Fikcyjny produkt testowy');
  console.log(JSON.stringify({environment:info.srodowisko,commit:info.commit_zrodla,tools:tools.length,syntheticReadWrite:'ok'}));
} finally { await client.close(); }
const next = new Client({name:'agf-local-smoke-fresh',version:'0.1.0'});
await next.connect(new StdioClientTransport({command:process.execPath,args:['--experimental-sqlite','chef-test.mjs'],cwd:process.cwd(),stderr:'pipe'}));
try {
  const item = await next.callTool({name:'pobierz_produkt',arguments:{id:1}});
  assert.notEqual(item.structuredContent.produkt.nazwa_handlowa, 'Fikcyjny produkt testowy');
  console.log(JSON.stringify({freshProcessSyntheticIsolation:'ok'}));
} finally { await next.close(); }
