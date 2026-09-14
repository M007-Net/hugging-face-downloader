const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Transfer, fileMatches, finishedPartial, neededBytes } = require('../desktop/transfer.cjs');

const digest = value => createHash('sha256').update(value).digest('hex');

test('existing files require a matching SHA-256, not just a matching size', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'hfd-transfer-'));
  const file = path.join(dir,'model.gguf');
  fs.writeFileSync(file,'good');
  assert.equal(await fileMatches(file,{ size:4, sha256:digest('good') }),true);
  assert.equal(await fileMatches(file,{ size:4, sha256:digest('evil') }),false);
  assert.equal(await fileMatches(file,{ size:4, sha256:'' }),false);
  assert.equal(await finishedPartial(file,{ size:4, sha256:digest('good') }),true);
  fs.rmSync(dir,{ recursive:true, force:true });
});

test('remaining-space calculation accounts for resumable partial data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'hfd-space-'));
  fs.writeFileSync(path.join(dir,'model.gguf.part'),Buffer.alloc(25));
  assert.equal(neededBytes([{ path:'model.gguf', size:100, status:'waiting' }],dir),75);
  fs.rmSync(dir,{ recursive:true, force:true });
});

test('transfer uses stdin, verifies the partial, and promotes only a complete file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'hfd-run-'));
  const body = Buffer.from('verified model data');
  let manifest = '';
  const spawnProcess = (_exe,args) => {
    assert.ok(args.includes('--input-file=-'));
    const child = new EventEmitter();
    child.stdin = { end(value) {
      manifest = value;
      const match = value.match(/^  out=(.+)$/m);
      fs.writeFileSync(path.join(dir,match[1].trim()),body);
      setImmediate(()=>child.emit('close',0,null));
    }};
    child.kill = () => child.emit('close',143,'SIGTERM');
    return child;
  };
  const transfer = new Transfer({ spawnProcess, resolveForFile:async()=>({ url:'https://cdn.example/signed', headers:[], maxRedirect:10 }) });
  transfer.start({ info:{ repo:'owner/repo', kind:'models', rev:'main' }, destination:dir, files:[{ path:'model.gguf', size:body.length, sha256:digest(body) }] },'aria2c.exe',{ connections:8 },'secret');
  await transfer.done;
  assert.equal(transfer.job.status,'complete');
  assert.equal(fs.readFileSync(path.join(dir,'model.gguf'),'utf8'),body.toString());
  assert.match(manifest,/^https:\/\/cdn\.example\/signed$/m);
  assert.match(manifest,/checksum=sha-256=/);
  assert.doesNotMatch(manifest,/secret|Authorization/i);
  assert.equal(fs.existsSync(path.join(dir,'.hugging-face-downloader.lock')),false);
  fs.rmSync(dir,{ recursive:true, force:true });
});

test('a failed file does not stop the rest of the queue', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'hfd-failure-'));
  let call = 0;
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdin = { end(value) {
      call++;
      if (call === 2) {
        const out = value.match(/^  out=(.+)$/m)[1].trim();
        fs.writeFileSync(path.join(dir,out),'ok');
      }
      setImmediate(()=>child.emit('close',call === 1 ? 3 : 0,null));
    }};
    child.kill = () => child.emit('close',143,'SIGTERM');
    return child;
  };
  const transfer = new Transfer({ spawnProcess, resolveForFile:async()=>({ url:'https://cdn.example/file', headers:[], maxRedirect:10 }) });
  transfer.start({ info:{ repo:'owner/repo', kind:'models', rev:'main' }, destination:dir, files:[{ path:'missing.gguf', size:2, sha256:digest('no') },{ path:'good.gguf', size:2, sha256:digest('ok') }] },'aria2c.exe',{ connections:4 },'');
  await transfer.done;
  assert.equal(transfer.job.status,'error');
  assert.equal(transfer.job.files[0].status,'error');
  assert.equal(transfer.job.files[1].status,'complete');
  fs.rmSync(dir,{ recursive:true, force:true });
});
