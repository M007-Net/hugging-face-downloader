// Optional loopback integration test: requires a local aria2 executable.
// No Hugging Face requests, credentials, or model downloads are involved.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Transfer, controlFileBytes } = require('../desktop/transfer.cjs');
const { findAria } = require('../desktop/core.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
test('real aria2 resumes twice and restores a saved queue without refetching finished files', { timeout:45000 }, async t => {
  const executable = findAria(process.env.HFD_TEST_ARIA2, path.resolve(__dirname, '..'));
  assert.ok(executable, 'Install aria2 or set HFD_TEST_ARIA2');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfd-real-resume-'));
  const bodies = { 'first.bin':Buffer.from('first'), 'model.bin':Buffer.alloc(12 * 1024 * 1024, 73) };
  const requests = [];
  const server = http.createServer((req, res) => {
    const name = req.url.slice(1); const body = bodies[name];
    if (!body) { res.writeHead(404); res.end(); return; }
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    let at = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    requests.push({ name, start:at, method:req.method });
    res.writeHead(range ? 206 : 200, { 'Content-Length':end - at + 1, 'Accept-Ranges':'bytes', 'ETag':'"stable-fixture"', ...(range ? { 'Content-Range':`bytes ${at}-${end}/${body.length}` } : {}) });
    const tick = setInterval(() => {
      if (res.destroyed) { clearInterval(tick); return; }
      const next = Math.min(at + 65536, end + 1);
      res.write(body.subarray(at, next)); at = next;
      if (at > end) { clearInterval(tick); res.end(); }
    }, 10);
    res.on('close', () => clearInterval(tick));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let transfer;
  t.after(async () => { await transfer?.pause(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive:true, force:true }); });
  const resolveForFile = async (_info, name) => ({ url:`http://127.0.0.1:${server.address().port}/${name}`, headers:[] });
  transfer = new Transfer({ resolveForFile });
  let job = { info:{ repo:'fixture/model' }, destination:dir, files:Object.entries(bodies).map(([name, body]) => ({ path:name, size:body.length, sha256:createHash('sha256').update(body).digest('hex') })) };
  for (let pass = 0; pass < 2; pass++) {
    transfer.start(job, executable, { connections:1 }, '');
    const deadline = Date.now() + 10000;
    while ((controlFileBytes(path.join(dir, 'model.bin.part')) || 0) < (pass + 1) * 2 * 1024 * 1024) {
      assert.ok(transfer.busy, transfer.job.error);
      assert.ok(Date.now() < deadline, 'aria2 must save resumable progress');
      await sleep(50);
    }
    await transfer.pause();
    assert.equal(transfer.job.status, 'paused');
    assert.equal(transfer.busy, false);
    assert.equal(transfer.child, null);
    assert.equal(fs.existsSync(path.join(dir, '.hugging-face-downloader.lock')), false);
    job = JSON.parse(JSON.stringify(transfer.job));
    // Equivalent to opening a fresh app with last-download.json after pausing.
    transfer = new Transfer({ resolveForFile });
  }
  transfer.start(job, executable, { connections:1 }, '');
  await transfer.done;
  assert.equal(transfer.job.status, 'complete', transfer.job.error);
  for (const [name, body] of Object.entries(bodies)) assert.deepEqual(fs.readFileSync(path.join(dir, name)), body);
  assert.equal(requests.filter(req => req.name === 'first.bin').length, 1, JSON.stringify(requests));
  assert.ok(requests.filter(req => req.name === 'model.bin' && req.start > 0).length >= 2, 'both resumes use HTTP byte ranges');
});
