const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Transfer, fileMatches, finishedPartial, neededBytes, controlFileBytes, progressBytes, recoverControlFile, aria2Progress, ariaArguments } = require('../desktop/transfer.cjs');

const digest = value => createHash('sha256').update(value).digest('hex');

test('pausing verification releases the lock and preserves staged bytes for resume', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfd-pause-hash-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  fs.writeFileSync(path.join(dir, 'model.gguf.part'), 'good');
  let paused; let requested = false;
  const transfer = new Transfer({ resolveForFile:async () => { throw new Error('finished staged data must not be fetched'); } });
  transfer.on('update', job => {
    if (job.files[0].status === 'verifying' && !requested) {
      requested = true;
      queueMicrotask(() => { paused = transfer.pause(); });
    }
  });
  transfer.start({ info:{ repo:'owner/repo' }, destination:dir, files:[{ path:'model.gguf', size:4, sha256:digest('good') }] }, 'aria2', {}, '');
  await transfer.done; await paused;
  assert.equal(transfer.job.status, 'paused');
  assert.equal(fs.readFileSync(path.join(dir, 'model.gguf.part'), 'utf8'), 'good');
  assert.equal(fs.existsSync(path.join(dir, '.hugging-face-downloader.lock')), false);
  transfer.start(transfer.job, 'aria2', {}, '');
  await transfer.done;
  assert.equal(transfer.job.status, 'complete', transfer.job.error);
});

test('a live download lock remains exclusive after more than a day', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfd-old-lock-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const filename = path.join(dir, '.hugging-face-downloader.lock');
  const held = JSON.stringify({ pid:process.pid, created:new Date(Date.now() - 48 * 3600000).toISOString() });
  fs.writeFileSync(filename, held);
  const transfer = new Transfer();
  transfer.start({ info:{ repo:'owner/repo' }, destination:dir, files:[{ path:'model.gguf', size:4 }] }, 'aria2', {}, '');
  await transfer.done;
  assert.equal(transfer.job.status, 'error');
  assert.match(transfer.job.error, /already writing/);
  assert.equal(fs.readFileSync(filename, 'utf8'), held);
});

test('temporary control saves replace stale canonical saves but malformed saves do not', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfd-newer-control-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const partial = path.join(dir, 'model.gguf.part');
  fs.writeFileSync(partial, Buffer.alloc(12));
  const old = controlFile({ pieceLength:4, totalLength:12, done:[0] });
  const recent = controlFile({ pieceLength:4, totalLength:12, done:[0,1] });
  fs.writeFileSync(partial + '.aria2', old);
  fs.writeFileSync(partial + '.aria2__temp', recent);
  fs.utimesSync(partial + '.aria2', new Date(0), new Date(0));
  assert.equal(recoverControlFile(partial), true);
  assert.deepEqual(fs.readFileSync(partial + '.aria2'), recent);
  fs.writeFileSync(partial + '.aria2__temp', Buffer.alloc(3));
  assert.equal(recoverControlFile(partial), false);
  assert.deepEqual(fs.readFileSync(partial + '.aria2'), recent);
});

test('pausing while resolving a URL never starts a child, and resume completes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfd-pause-resolve-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  let release; let calls = 0;
  const ready = new Promise(resolve => { release = resolve; });
  const transfer = new Transfer({
    resolveForFile: async () => { await ready; return { url:'https://example.com/model' }; },
    spawnProcess: () => {
      calls++;
      const child = new EventEmitter();
      child.stdin = { end() { fs.writeFileSync(path.join(dir, 'model.gguf.part'), 'good'); setImmediate(() => child.emit('close', 0)); } };
      child.kill = () => child.emit('close', 143);
      return child;
    }
  });
  transfer.start({ info:{ repo:'owner/repo' }, destination:dir, files:[{ path:'model.gguf', size:4, sha256:digest('good') }] }, 'aria2', {}, '');
  const paused = transfer.pause();
  release();
  await paused;
  assert.equal(calls, 0, 'pause must prevent a late URL resolution from launching aria2');
  assert.equal(transfer.job.status, 'paused');
  transfer.start(transfer.job, 'aria2', {}, '');
  await transfer.done;
  assert.equal(transfer.job.status, 'complete', transfer.job.error);
});

test('retry replaces corrupt final and staged files instead of checking them forever', async t => {
  for (const suffix of ['', '.part']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfd-corrupt-retry-'));
    t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
    fs.writeFileSync(path.join(dir, 'model.gguf' + suffix), 'evil');
    let calls = 0;
    const transfer = new Transfer({
      resolveForFile: async () => ({ url:'https://example.com/model' }),
      spawnProcess: () => {
        calls++;
        const child = new EventEmitter();
        child.stdin = { end() {
          const partial = path.join(dir, 'model.gguf.part');
          // aria2 --continue does not overwrite a full-length file without a control file.
          if (!fs.existsSync(partial)) fs.writeFileSync(partial, 'good');
          setImmediate(() => child.emit('close', 0));
        } };
        child.kill = () => child.emit('close', 143);
        return child;
      }
    });
    transfer.start({ info:{ repo:'owner/repo' }, destination:dir, files:[{ path:'model.gguf', size:4, sha256:digest('good') }] }, 'aria2', {}, '');
    await transfer.done;
    assert.equal(transfer.job.status, 'error');
    transfer.start(transfer.job, 'aria2', {}, '');
    await transfer.done;
    assert.equal(transfer.job.status, 'complete', transfer.job.error);
    assert.equal(fs.readFileSync(path.join(dir, 'model.gguf'), 'utf8'), 'good');
    assert.ok(calls > 0);
  }
});

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
  fs.truncateSync(path.join(dir,'model.gguf.part'),100);
  fs.writeFileSync(path.join(dir,'model.gguf.part.aria2'),controlFile({ pieceLength:25, totalLength:100, done:[0] }));
  assert.equal(neededBytes([{ path:'model.gguf', size:100, status:'waiting' }],dir),75,'sparse final length must not conceal remaining disk requirements');
  fs.rmSync(dir,{ recursive:true, force:true });
});

test('aria2 receives the selected UNC directory unchanged', () => {
  const uncTarget = String.raw`\\fileserver\models\owner\repo\model.gguf.part`;
  const directory = path.win32.dirname(uncTarget);
  const args = ariaArguments(directory);
  assert.equal(args[args.indexOf('--dir') + 1], String.raw`\\fileserver\models\owner\repo`);
});

test('aria2 summary reports live bytes even when the partial file has its final length', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'hfd-live-progress-'));
  const body = Buffer.alloc(100, 7);
  const seen = [];
  const spawnProcess = (_exe, args) => {
    assert.ok(args.includes('--summary-interval=1'));
    assert.ok(args.includes('--show-console-readout=true'));
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
    child.stdin = { end(manifest) {
      const out = manifest.match(/^  out=(.+)$/m)[1].trim();
      const partial = path.join(dir, out);
      fs.writeFileSync(partial, '');
      fs.truncateSync(partial, body.length);
      setTimeout(() => child.stdout.emit('data', '[#14eabd 20B/100B(20%) CN:1 DL:5B ETA:16s]\n'), 30);
      setTimeout(() => { fs.writeFileSync(partial, body); child.emit('close', 0, null); }, 700);
    }};
    child.kill = () => child.emit('close', 143, 'SIGTERM');
    return child;
  };
  const transfer = new Transfer({ spawnProcess, resolveForFile:async()=>({ url:'https://cdn.example/file', headers:[] }) });
  transfer.on('update', job => {
    if (job.files[0].status === 'downloading') seen.push({ completed:job.files[0].completed, speed:job.files[0].speed });
  });
  transfer.start({ info:{ repo:'owner/repo', kind:'models', rev:'main' }, destination:dir, files:[{ path:'model.gguf', size:body.length, sha256:digest(body) }] },'aria2c.exe',{ connections:1 },'');
  await transfer.done;
  assert.deepEqual(aria2Progress('[#14eabd 20B/100B(20%) CN:1 DL:5B ETA:16s]'), { completed:20, speed:5 });
  assert.ok(seen.some(value => value.completed === 20 && value.speed === 5), 'the display uses aria2 live progress');
  assert.ok(seen.every(value => value.completed < 100), 'sparse file length is not reported as complete');
  assert.equal(transfer.job.status, 'complete');
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
  const transfer = new Transfer({ spawnProcess, resolveForFile:async()=>({ url:'https://cdn.example/signed', headers:[] }) });
  transfer.start({ info:{ repo:'owner/repo', kind:'models', rev:'main' }, destination:dir, files:[{ path:'model.gguf', size:body.length, sha256:digest(body) }] },'aria2c.exe',{ connections:8 },'secret');
  await transfer.done;
  assert.equal(transfer.job.status,'complete');
  assert.equal(fs.readFileSync(path.join(dir,'model.gguf'),'utf8'),body.toString());
  assert.match(manifest,/^https:\/\/cdn\.example\/signed$/m);
  assert.doesNotMatch(manifest,/checksum=/,'aria2 should not hash each file before the queue finishes');
  assert.doesNotMatch(manifest,/max-(?:http-)?redirect=/i,'aria2 has no per-download redirect-limit option');
  assert.doesNotMatch(manifest,/secret|Authorization/i);
  assert.equal(fs.existsSync(path.join(dir,'.hugging-face-downloader.lock')),false);
  fs.rmSync(dir,{ recursive:true, force:true });
});

test('the whole queue downloads before checking existing and staged files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'hfd-deferred-'));
  fs.writeFileSync(path.join(dir,'existing.gguf'),'old');
  const seen = [];
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdin = { end(manifest) {
      const out = manifest.match(/^  out=(.+)$/m)[1].trim();
      fs.writeFileSync(path.join(dir,out),'new');
      seen.push('downloaded');
      assert.equal(fs.existsSync(path.join(dir,'new.gguf')),false);
      setImmediate(()=>child.emit('close',0,null));
    }};
    child.kill = () => child.emit('close',143,'SIGTERM');
    return child;
  };
  const transfer = new Transfer({ spawnProcess, resolveForFile:async()=>({ url:'https://cdn.example/file', headers:[] }) });
  transfer.on('update', job => {
    if (job.status === 'verifying' && !seen.includes('checking')) seen.push('checking');
  });
  transfer.start({ info:{ repo:'owner/repo' }, destination:dir, files:[
    { path:'existing.gguf', size:3, sha256:digest('old') },
    { path:'new.gguf', size:3, sha256:digest('new') }
  ] },'aria2c.exe',{ connections:1 },'');
  await transfer.done;
  assert.deepEqual(seen,['downloaded','checking']);
  assert.equal(transfer.job.status,'complete');
  assert.equal(fs.readFileSync(path.join(dir,'new.gguf'),'utf8'),'new');
  fs.rmSync(dir,{ recursive:true, force:true });
});

test('transfer refuses Authorization headers before spawning aria2', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'hfd-auth-'));
  let spawned = false;
  const transfer = new Transfer({
    spawnProcess: () => { spawned = true; throw new Error('must not spawn'); },
    resolveForFile: async () => ({ url:'https://huggingface.co/private/file', headers:['Authorization: Bearer secret'] })
  });
  transfer.start({ info:{ repo:'owner/repo', kind:'models', rev:'main' }, destination:dir, files:[{ path:'model.gguf', size:1 }] },'aria2c.exe',{ connections:1 },'secret');
  await transfer.done;
  assert.equal(transfer.job.status,'error');
  assert.match(transfer.job.error,/Refusing to pass an Authorization header to aria2/);
  assert.equal(spawned,false);
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
  const transfer = new Transfer({ spawnProcess, resolveForFile:async()=>({ url:'https://cdn.example/file', headers:[] }) });
  transfer.start({ info:{ repo:'owner/repo', kind:'models', rev:'main' }, destination:dir, files:[{ path:'missing.gguf', size:2, sha256:digest('no') },{ path:'good.gguf', size:2, sha256:digest('ok') }] },'aria2c.exe',{ connections:4 },'');
  await transfer.done;
  assert.equal(transfer.job.status,'error');
  assert.equal(transfer.job.files[0].status,'error');
  assert.equal(transfer.job.files[1].status,'complete');
  fs.rmSync(dir,{ recursive:true, force:true });
});

// Builds the control file aria2 writes beside a partial download, so the reader can
// be tested without running aria2 or downloading anything.
function controlFile({ pieceLength, totalLength, done }) {
  const pieces = Math.ceil(totalLength / pieceLength);
  const bitfield = Buffer.alloc(Math.ceil(pieces / 8));
  for (const index of done) bitfield[index >> 3] |= 1 << (7 - (index & 7));
  const header = Buffer.alloc(10);
  header.writeUInt16BE(1, 0);                       // version
  header.writeUInt32BE(0, 2);                       // extension
  header.writeUInt32BE(0, 6);                       // infoHashLength: none for HTTP
  const body = Buffer.alloc(24);
  body.writeUInt32BE(pieceLength, 0);
  body.writeBigUInt64BE(BigInt(totalLength), 4);
  body.writeBigUInt64BE(0n, 12);                    // uploadLength
  body.writeUInt32BE(bitfield.length, 20);
  return Buffer.concat([header, body, bitfield, Buffer.alloc(4)]);
}

test('a valid temporary aria2 control file is recovered for resume', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'hfd-recover-'));
  const partial = path.join(dir,'model.gguf.part');
  fs.writeFileSync(partial, 'partial data');
  const temp = partial + '.aria2__temp';
  const canonical = partial + '.aria2';
  const saved = controlFile({ pieceLength:4, totalLength:12, done:[0,1] });
  fs.writeFileSync(temp, saved);
  assert.equal(recoverControlFile(partial), true);
  assert.deepEqual(fs.readFileSync(canonical), saved);
  assert.deepEqual(fs.readFileSync(temp), saved, 'the temporary original is preserved');
  assert.equal(recoverControlFile(partial), false, 'an existing canonical control file is not replaced');
  fs.rmSync(dir,{ recursive:true, force:true });
});

// The bug this replaced: progress was the size of the .part file. aria2 opens one
// connection per segment and each seeks straight to its own offset, so the file
// reaches full length within seconds while most of it is still a hole. The bar ran
// to 100%, and speed - the difference between two sizes that could no longer change
// - sat at 0 B/s for the rest of the download.
test('progress comes from aria2 accounting, not from how big the file has grown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'hfd-progress-'));
  const partial = path.join(dir,'model.gguf.part');
  const pieceLength = 1024 * 1024;
  const totalLength = pieceLength * 10 + 512;       // a short final piece

  // Ten of eleven pieces done, and the file already stretched to its full length.
  fs.writeFileSync(partial, Buffer.alloc(0));
  fs.truncateSync(partial, totalLength);
  fs.writeFileSync(partial + '.aria2', controlFile({ pieceLength, totalLength, done:[0,1,2,3,4,5,6,7,8,9] }));

  assert.equal(fs.statSync(partial).size, totalLength, 'the file really is full length already');
  assert.equal(controlFileBytes(partial), pieceLength * 10, 'ten whole pieces, not the file size');
  assert.equal(progressBytes(partial,{ size:totalLength }), pieceLength * 10);

  // The final piece is short. Counting it as a whole one would report more than the
  // file can hold, which is how a download reaches 101%.
  fs.writeFileSync(partial + '.aria2', controlFile({ pieceLength, totalLength, done:[0,1,2,3,4,5,6,7,8,9,10] }));
  assert.equal(controlFileBytes(partial), totalLength, 'every piece done is exactly the total');

  // Nothing yet, on a file already at full length: the case that used to read 100%.
  fs.writeFileSync(partial + '.aria2', controlFile({ pieceLength, totalLength, done:[] }));
  assert.equal(progressBytes(partial,{ size:totalLength }), 0);
  fs.rmSync(dir,{ recursive:true, force:true });
});

test('a control file being saved, missing, or unreadable never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'hfd-progress-'));
  const partial = path.join(dir,'model.gguf.part');
  const pieceLength = 1024 * 1024;
  const totalLength = pieceLength * 4;
  fs.writeFileSync(partial, Buffer.alloc(0));
  fs.truncateSync(partial, totalLength);

  // aria2 writes <name>.aria2__temp and renames it over <name>.aria2. A poll landing
  // in that gap must still find the reading.
  fs.writeFileSync(partial + '.aria2__temp', controlFile({ pieceLength, totalLength, done:[0,1] }));
  assert.equal(controlFileBytes(partial), pieceLength * 2, 'the half-saved name counts too');

  // SMB can leave the old canonical file in place while aria2 keeps writing
  // newer progress to the temporary name. The UI must follow the newer one.
  fs.writeFileSync(partial + '.aria2', controlFile({ pieceLength, totalLength, done:[0] }));
  const old = new Date(Date.now() - 3000); const recent = new Date();
  fs.utimesSync(partial + '.aria2', old, old);
  fs.utimesSync(partial + '.aria2__temp', recent, recent);
  assert.equal(controlFileBytes(partial), pieceLength * 2, 'fresh temporary progress beats a stale canonical file');
  fs.rmSync(partial + '.aria2');

  // No control file at all: fall back to the file size, capped at what is expected.
  fs.rmSync(partial + '.aria2__temp');
  assert.equal(controlFileBytes(partial), null);
  assert.equal(progressBytes(partial,{ size:totalLength }), totalLength);
  assert.equal(progressBytes(partial,{ size:totalLength / 2 }), totalLength / 2, 'never reports more than the file should be');

  // Truncated or foreign contents fall back rather than crashing the download.
  fs.writeFileSync(partial + '.aria2', Buffer.alloc(3));
  assert.equal(controlFileBytes(partial), null);
  fs.writeFileSync(partial + '.aria2', Buffer.from('not an aria2 control file at all'));
  assert.doesNotThrow(() => controlFileBytes(partial));

  // And a missing partial reports nothing rather than throwing.
  fs.rmSync(partial); fs.rmSync(partial + '.aria2');
  assert.equal(progressBytes(partial,{ size:totalLength }), 0);
  fs.rmSync(dir,{ recursive:true, force:true });
});
