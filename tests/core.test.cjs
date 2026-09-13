const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../desktop/core.cjs');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname,'repository-fixture.json'),'utf8').replace(/^\uFEFF/,''));
test('accepts HF shorthand, folders, datasets and encoded direct links', () => {
  assert.equal(core.parseLink('owner/repository').repo,'owner/repository');
  assert.equal(core.parseLink('https://hf.co/owner/repo/tree/main/Q4_K_M').subpath,'Q4_K_M');
  assert.equal(core.parseLink('https://huggingface.co/datasets/owner/repo').kind,'datasets');
  assert.equal(core.parseLink('https://huggingface.co/owner/repo/blob/main/model%20name.gguf').subpath,'model name.gguf');
  assert.equal(core.parseLink('https://huggingface.co/owner/repo/tree/refs/pr/3/quant').rev,'refs/pr/3');
});
test('rejects external URLs and unsafe Windows paths', () => {
  assert.throws(()=>core.parseLink('https://example.com/owner/repo'));
  for(const p of ['../file','/file','C:/file','a\\b','x/CON.gguf','foo:bar','dir/file.','dir//file']) assert.throws(()=>core.safePath(p));
});
test('recognizes quants without confusing integrated MTP with companions',()=>{
  assert.equal(core.quantName('model-UD-IQ3_S.gguf'),'UD-IQ3_S');
  assert.equal(core.quantName('Q4_K_M/model-00001-of-00002.gguf'),'Q4_K_M');
  assert.equal(core.bits('IQ3_XXS'),3); assert.equal(core.bits('BF16'),16);
  assert.equal(core.companionKind('model-MTP-Q4_K_M.gguf'),'');
  assert.equal(core.companionKind('MTP/mtp-model-Q8_0.gguf'),'mtp');
  assert.equal(core.companionKind('mmproj-F16.gguf'),'vision');
});
test('real repository fixture groups shards and keeps companions separate',()=>{
  const c=core.catalog(core.parseLink('example/repo'),fixture.filter(f=>f.type==='file'));
  assert.ok(c.bundles.some(b=>b.quant==='IQ4_XS'));
  const full=c.bundles.find(b=>b.quant==='BF16');assert.equal(full.files.length,2);assert.ok(full.complete);
  assert.equal(c.mtp.length,4);assert.ok(c.vision.length);
  assert.equal(core.bundles([full.files[0]])[0].complete,false);
  assert.ok(c.bundles.every(b=>!core.companionKind(b.name)));
});
test('folder catalog still offers root-level companions',()=>{
  const c=core.catalog(core.parseLink('https://huggingface.co/example/repo/tree/main/BF16'),fixture.filter(f=>f.type==='file'));
  assert.equal(c.files.length,2);assert.equal(c.mtp.length,4);assert.ok(c.vision.length);
});
test('pagination retrieves all files and refuses third-party next-page hosts',async()=>{
  let count=0;const fetcher=async()=>({ok:true,headers:new Headers(count++===0?{link:'<https://huggingface.co/api/models/owner/repo/tree/main?cursor=2>; rel="next"'}:{}),json:async()=>[{type:'file',path:`model-Q${count}_K.gguf`,size:100}]});
  const c=await core.listRepo('owner/repo','',fetcher);assert.equal(c.files.length,2);
  await assert.rejects(core.listRepo('owner/repo','',async()=>({ok:true,headers:new Headers({link:'<https://example.com/steal>; rel="next"'}),json:async()=>[]})),/Unexpected/);
});
test('access errors are actionable and download URLs escape filenames',async()=>{
  await assert.rejects(core.listRepo('owner/repo','',async()=>({ok:false,status:403})),/read token/);
  assert.equal(core.downloadUrl(core.parseLink('owner/repo'),'model name.gguf'),'https://huggingface.co/owner/repo/resolve/main/model%20name.gguf?download=true');
});
