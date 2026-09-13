const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { safePath, downloadUrl } = require('./core.cjs');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(r => server.close(r)); return port;
}
class Transfer extends EventEmitter {
  constructor({ urlForFile = downloadUrl } = {}) { super(); this.job = null; this.busy = false; this.urlForFile = urlForFile; }
  publish() { this.emit('update', this.job); }
  start(job, executable, options, token) {
    if (this.busy) throw new Error('A download is already running in this app.');
    if (!job.files?.length) throw new Error('Choose at least one file.');
    for (const file of job.files) safePath(file.path);
    this.busy = true; this.pausing = false;
    this.job = { ...job, status: 'starting', error: '', files: job.files.map(f => ({ ...f, status: 'waiting', completed: 0, speed: 0 })) };
    this.publish();
    this.done = this.run(executable, options, token).catch(e => { this.job.status = this.pausing ? 'paused' : 'error'; this.job.error = this.pausing ? '' : e.message; }).finally(() => { this.busy = false; this.publish(); });
    return this.job;
  }
  async pause() { if (this.busy) { this.pausing = true; await this.done; } return this.job; }
  async run(executable, options, token) {
    const port = await freePort(); const secret = randomBytes(24).toString('hex');
    const args = ['--no-conf=true', '--enable-rpc=true', '--rpc-listen-all=false', `--rpc-listen-port=${port}`, `--rpc-secret=${secret}`, '--disable-ipv6=true', '--console-log-level=error', '--download-result=hide', '--summary-interval=0', '--enable-color=false'];
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    this.child = child; let processError;
    child.on('error', e => { processError = e; });
    // aria2 diagnostics may contain signed URLs, so they are not logged or persisted.
    child.stdout.resume(); child.stderr.resume();
    const closed = new Promise(resolve => { child.once('close', resolve); child.once('error', resolve); });
    const rpc = async (method, parameters = []) => {
      const response = await fetch(`http://127.0.0.1:${port}/jsonrpc`, { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'download', method:`aria2.${method}`, params:[`token:${secret}`, ...parameters] }), signal: AbortSignal.timeout(4000) });
      const body = await response.json(); if (body.error) throw new Error('The download engine could not process the request.'); return body.result;
    };
    try {
      let ready = false;
      for (let n = 0; n < 60 && !this.pausing; n++) {
        if (processError) throw new Error('Could not start aria2. Check its location in Settings.');
        try { await rpc('getVersion'); ready = true; break; } catch { await delay(100); }
      }
      if (this.pausing) { this.job.status = 'paused'; return; }
      if (!ready) throw new Error('The download engine did not start. Check aria2 in Settings.');
      this.job.status = 'downloading';
      for (const file of this.job.files) {
        if (this.pausing) break;
        const target = path.join(this.job.destination, ...file.path.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (file.size > 0 && fs.existsSync(target) && fs.statSync(target).size === file.size && !fs.existsSync(target + '.aria2')) { file.status = 'complete'; file.completed = file.size; this.publish(); continue; }
        const connections = String(Math.min(16, Math.max(1, Number(options.connections) || 16)));
        const downloadOptions = { dir: path.dirname(target), out: path.basename(target), continue:'true', 'auto-file-renaming':'false', 'file-allocation':'none', split: connections, 'max-connection-per-server': connections, 'min-split-size':'1M', 'max-tries':'5', 'retry-wait':'3', 'timeout':'60', 'connect-timeout':'30', 'disable-ipv6':'true' };
        if (token) downloadOptions.header = [`Authorization: Bearer ${token}`];
        const gid = await rpc('addUri', [[this.urlForFile(this.job.info, file.path)], downloadOptions]);
        file.status = 'downloading'; this.publish();
        while (true) {
          if (this.pausing) { await rpc('forcePause', [gid]).catch(() => {}); file.status = 'paused'; file.speed = 0; break; }
          const status = await rpc('tellStatus', [gid, ['status','totalLength','completedLength','downloadSpeed','errorCode']]);
          file.completed = Number(status.completedLength); file.speed = Number(status.downloadSpeed);
          if (Number(status.totalLength)) file.size = Number(status.totalLength);
          if (status.status === 'complete') { file.status = 'complete'; file.speed = 0; this.publish(); break; }
          if (status.status === 'error' || status.status === 'removed') {
            file.status = 'error'; file.speed = 0;
            throw new Error(status.errorCode === '3' ? 'A file was not found. Reload the repository listing.' : status.errorCode === '22' || status.errorCode === '24' ? 'Access denied. Check your Hugging Face token and model access.' : `Download failed (aria2 code ${status.errorCode || 'unknown'}). Check the connection and retry; partial files are kept.`);
          }
          this.publish(); await delay(500);
        }
      }
      this.job.status = this.pausing ? 'paused' : 'complete';
    } finally {
      await rpc('shutdown').catch(() => {});
      const killTimer = setTimeout(() => child.kill(), 2500);
      await closed; clearTimeout(killTimer); this.child = null;
    }
  }
}
module.exports = { Transfer };
