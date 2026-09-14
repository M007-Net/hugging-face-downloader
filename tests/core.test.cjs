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
test('Gemma 4 31B repository names map to quant, vision, and MTP choices',()=>{
  const names = [
    'gemma-4-31B-it-UD-Q4_K_XL.gguf', 'gemma-4-31B-it-UD-IQ3_XXS.gguf',
    'gemma-4-31B-it-Q4_K_M.gguf', 'mmproj-F16.gguf', 'mtp-gemma-4-31B-it.gguf'
  ];
  assert.equal(core.quantName(names[0]), 'UD-Q4_K_XL');
  assert.equal(core.quantName(names[1]), 'UD-IQ3_XXS');
  assert.equal(core.bits(core.quantName(names[2])), 4);
  assert.equal(core.companionKind(names[3]), 'vision');
  assert.equal(core.companionKind(names[4]), 'mtp');
  const catalog = core.catalog(core.parseLink('unsloth/gemma-4-31B-it-GGUF'), names.map(path => ({ path, size: 100 })));
  assert.ok(catalog.bundles.some(bundle => bundle.quant === 'UD-Q4_K_XL'));
  assert.equal(catalog.vision.length, 1);
  assert.equal(catalog.mtp.length, 1);
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
test('follows same-site API redirects but never sends tokens off Hugging Face',async()=>{
  let calls=0; const seen=[];
  const fetcher=async(url,options)=>{seen.push({url:String(url),redirect:options.redirect,auth:options.headers.Authorization});calls++; if(calls===1)return {status:307,headers:new Headers({location:'/api/models/owner/repo/tree/main?recursive=true'}),ok:false}; return {status:200,ok:true,headers:new Headers(),json:async()=>[{type:'file',path:'model-Q4_K.gguf',size:100}]};};
  const c=await core.listRepo('owner/repo','secret',fetcher); assert.equal(c.files.length,1); assert.equal(calls,2); assert.deepEqual(seen.map(x=>x.redirect),['manual','manual']); assert.ok(seen.every(x=>x.auth==='Bearer secret'));
  await assert.rejects(core.listRepo('owner/repo','secret',async(_url,options)=>({status:302,ok:false,headers:new Headers({location:'https://evil.example/steal'})})),/Unexpected/);
});
test('a file Windows cannot name is skipped, not fatal to the whole listing',async()=>{
  const page=[
    {type:'file',path:'model-Q4_K_M.gguf',size:100},
    {type:'file',path:'weird:name.bin',size:10},      // colon
    {type:'file',path:'trailing.',size:10},           // trailing dot
    {type:'file',path:'sub/CON.gguf',size:10},        // reserved device name
    {type:'file',path:'mmproj-F16.gguf',size:20}
  ];
  const c=await core.listRepo('owner/repo','',async()=>({ok:true,status:200,headers:new Headers(),json:async()=>page}));
  assert.equal(c.skipped,3);
  assert.deepEqual(c.allFiles.map(f=>f.path),['model-Q4_K_M.gguf','mmproj-F16.gguf']);
  assert.ok(c.bundles.some(b=>b.quant==='Q4_K_M'));
  assert.equal(c.vision.length,1);
  // Everything that survives must still pass the download-time check.
  for(const f of c.allFiles) assert.doesNotThrow(()=>core.safePath(f.path));
});
test('a repository of only unsafe names fails with a specific message',async()=>{
  await assert.rejects(
    core.listRepo('owner/repo','',async()=>({ok:true,status:200,headers:new Headers(),json:async()=>[{type:'file',path:'a:b',size:1}]})),
    /saved safely on Windows/);
});
test('access errors are actionable and download URLs escape filenames',async()=>{
  await assert.rejects(core.listRepo('owner/repo','',async()=>({ok:false,status:403})),/read token/);
  assert.equal(core.downloadUrl(core.parseLink('owner/repo'),'model name.gguf'),'https://huggingface.co/owner/repo/resolve/main/model%20name.gguf?download=true');
});
test('pins downloads to the repository commit and encodes slashed revisions by segment',async()=>{
  const commit='a'.repeat(40);
  const c=await core.listRepo('https://huggingface.co/owner/repo/tree/refs/pr/3','',async()=>({ok:true,status:200,headers:new Headers({'x-repo-commit':commit}),json:async()=>[{type:'file',path:'model name.gguf',size:10,lfs:{sha256:'b'.repeat(64)}}]}));
  assert.equal(c.info.commit,commit);
  assert.equal(c.files[0].sha256,'b'.repeat(64));
  assert.equal(core.downloadUrl(c.info,c.files[0].path),`https://huggingface.co/owner/repo/resolve/${commit}/model%20name.gguf?download=true`);
  assert.equal(core.downloadUrl(core.parseLink('https://huggingface.co/owner/repo/tree/refs/pr/3'),'model.gguf'),'https://huggingface.co/owner/repo/resolve/refs/pr/3/model.gguf?download=true');
});
test('rejects token controls and Windows case, normalization, and file-directory collisions',async()=>{
  assert.throws(()=>core.validToken('safe\r\n  header=bad'),/invalid/);
  const files=[{path:'A.gguf'},{path:'a.gguf'},{path:'folder'},{path:'folder/model.gguf'},{path:'café.gguf'},{path:'café.gguf'},{path:'ok.gguf'}];
  assert.deepEqual(core.withoutWindowsCollisions(files).files.map(f=>f.path),['folder','ok.gguf']);
});
test('resolves authenticated redirects without forwarding the token to a CDN',async()=>{
  const seen=[];
  const prepared=await core.resolveDownload(core.parseLink('owner/repo'),'model.gguf','secret',async(url,options)=>{
    seen.push({url:String(url),auth:options.headers.Authorization,redirect:options.redirect});
    return {status:302,ok:false,headers:new Headers({location:'https://cdn.example/signed'})};
  });
  assert.equal(prepared.url,'https://cdn.example/signed');
  assert.deepEqual(prepared.headers,[]);
  assert.equal(prepared.maxRedirect,10);
  assert.equal(seen[0].auth,'Bearer secret');
  assert.equal(seen[0].redirect,'manual');
});
