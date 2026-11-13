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
  for (const [oldName,newName] of [['szukaj_produktow','przegladaj_skladniki'],['szukaj_wariantow_posilkow','przegladaj_posilki']]) {
    if (tools.some(t=>t.name===newName)) {
      assert.equal(tools.some(t=>t.name===oldName),false);
      const deniedOld=await client.callTool({name:oldName,arguments:{fraza:'Test'}});
      assert.equal(deniedOld.isError,true);
    }
  }
  assert.ok(tools.some(t=>t.name==='pobierz_produkt'));
  assert.ok(tools.some(t=>t.name==='pobierz_wariant_posilku'));
  for (const section of ['baza','obliczenia']) {
    const instructions=await client.callTool({name:'instrukcje_chefa',arguments:{sekcja:section}});
    assert.equal(instructions.isError,undefined);
    if (tools.some(t=>t.name==='przegladaj_skladniki')) assert.doesNotMatch(instructions.structuredContent.tresc,/`szukaj_produktow`/);
    if (tools.some(t=>t.name==='przegladaj_posilki')) assert.doesNotMatch(instructions.structuredContent.tresc,/`szukaj_wariantow_posilkow`/);
  }
  const info = JSON.parse((await client.callTool({name:'chef_test_srodowisko',arguments:{}})).content[0].text);
  assert.equal(info.srodowisko, 'chef-test');
  assert.equal(info.commit_zrodla, JSON.parse(readFileSync('chef-test-source.json','utf8')).commit);
  const hasCategories = Object.hasOwn(JSON.parse(readFileSync('chef-test-source.json','utf8')).files, 'src/category-schema.js');
  assert.equal(info.schemat_kategorii, hasCategories);
  assert.equal(tools.some(t => t.name === 'eksploruj_baze'), hasCategories);
  assert.equal(tools.some(t => t.name === 'edytuj_kategorie'), hasCategories);
  if (hasCategories) {
    const categories = await client.callTool({name:'eksploruj_baze',arguments:{verified:true}});
    assert.equal(categories.isError, undefined);
    assert.ok(categories.structuredContent.kategorie.length > 0);
    assert.equal(categories.structuredContent.dane_demo, true);
  }
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
