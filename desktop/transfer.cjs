const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { safePath, resolveDownload } = require('./core.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function describeAria2Error(code) {
  if (code === 3) return 'Not found on Hugging Face (404). Reload the repository listing.';
  if (code === 9) return 'There is not enough free disk space for this file.';
  if (code === 22) return 'Hugging Face returned an HTTP error. Check the repository, revision, token, and access terms.';
  if (code === 24) return 'Authorization failed. Check your Hugging Face token and model access.';
  return `Download failed (aria2 code ${code ?? 'unknown'}). Partial data is kept, so retrying resumes.`;
}

function hashFile(filename) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = fs.createReadStream(filename);
    input.on('error', reject);
    input.on('data', chunk => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function fileMatches(filename, file) {
  if (!fs.existsSync(filename) || fs.existsSync(filename + '.aria2')) return false;
  const stat = fs.statSync(filename);
  if (!stat.isFile() || (file.size > 0 && stat.size !== file.size)) return false;
  if (!file.sha256) return false;
  return (await hashFile(filename)) === file.sha256;
}

async function finishedPartial(filename, file) {
  if (!fs.existsSync(filename) || fs.existsSync(filename + '.aria2')) return false;
  const stat = fs.statSync(filename);
  if (!stat.isFile() || (file.size > 0 && stat.size !== file.size)) return false;
  return !file.sha256 || (await hashFile(filename)) === file.sha256;
}

function rejectNestedLinks(destination, target) {
  const relative = path.relative(destination, path.dirname(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('The download path escaped the selected repository folder.');
  let current = destination;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`Refusing to write through a symbolic link or junction: ${current}`);
  }
}

function availableBytes(destination) {
  let current = path.resolve(destination);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  try {
    const stat = fs.statfsSync(current);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch { return null; }
}

function neededBytes(files, destination) {
  return files.reduce((sum, file) => {
    if (file.status === 'complete' || !(file.size > 0)) return sum;
    const partial = path.join(destination, ...file.path.split('/')) + '.part';
    let existing = 0;
    try { existing = fs.statSync(partial).size; } catch {}
    return sum + Math.max(0, file.size - existing);
  }, 0);
}

function acquireLock(destination) {
  fs.mkdirSync(destination, { recursive: true });
  const filename = path.join(destination, '.hugging-face-downloader.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(filename, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, created: new Date().toISOString() }));
      return { fd, filename };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid = 0;
      try { pid = Number(JSON.parse(fs.readFileSync(filename, 'utf8')).pid); } catch {}
      let running = false;
      if (pid > 0) try { process.kill(pid, 0); running = true; } catch {}
      if (running) throw new Error('Another downloader is already writing to this repository folder.');
      try { fs.unlinkSync(filename); } catch { throw new Error('A stale download lock could not be cleared.'); }
    }
  }
  throw new Error('Could not lock the repository folder.');
}

function releaseLock(lock) {
  if (!lock) return;
  try { fs.closeSync(lock.fd); } catch {}
  try { fs.unlinkSync(lock.filename); } catch {}
}

class Transfer extends EventEmitter {
  constructor({ resolveForFile = resolveDownload, spawnProcess = spawn } = {}) {
    super(); this.job = null; this.busy = false; this.resolveForFile = resolveForFile; this.spawnProcess = spawnProcess; this.child = null;
  }
  publish() { this.emit('update', this.job); }
  start(job, executable, options, token) {
    if (this.busy) throw new Error('A download is already running in this app.');
    if (!job.files?.length) throw new Error('Choose at least one file.');
    for (const file of job.files) safePath(file.path);
    this.busy = true; this.pausing = false;
    this.job = { ...job, status: 'starting', error: '', files: job.files.map(file => ({ ...file, status: 'waiting', completed: 0, speed: 0, error: '' })) };
    this.publish();
    this.done = this.run(executable, options, token)
      .catch(error => { this.job.status = this.pausing ? 'paused' : 'error'; this.job.error = this.pausing ? '' : error.message; })
      .finally(() => { this.busy = false; this.child = null; this.publish(); });
    return this.job;
  }
  async pause() {
    if (this.busy) {
      this.pausing = true;
      if (this.child) try { this.child.kill(); } catch {}
      await this.done;
    }
    return this.job;
  }
  async run(executable, options, token) {
    const lock = acquireLock(this.job.destination);
    try {
      for (const file of this.job.files) {
        const target = path.join(this.job.destination, ...file.path.split('/'));
        if (target.length > 32760) throw new Error(`The destination path is too long for Windows: ${file.path}`);
        rejectNestedLinks(this.job.destination, target);
        if (await fileMatches(target, file)) { file.status = 'complete'; file.completed = file.size; }
      }
      const free = availableBytes(this.job.destination);
      const needed = neededBytes(this.job.files, this.job.destination);
      if (free !== null && needed > free) throw new Error(`Not enough free disk space. The selected files still need ${needed.toLocaleString()} bytes, but only ${free.toLocaleString()} bytes are available.`);
      this.job.status = 'downloading'; this.publish();
      const failures = [];
      for (const file of this.job.files) {
        if (this.pausing) break;
        if (file.status === 'complete') continue;
        const target = path.join(this.job.destination, ...file.path.split('/'));
        const partial = target + '.part';
        fs.mkdirSync(path.dirname(target), { recursive: true });
        rejectNestedLinks(this.job.destination, target);
        if (!fs.existsSync(partial) && fs.existsSync(target) && fs.existsSync(target + '.aria2')) {
          fs.renameSync(target, partial);
          fs.renameSync(target + '.aria2', partial + '.aria2');
        }
        try {
          const prepared = await this.resolveForFile(this.job.info, file.path, token);
          const connections = String(Math.min(16, Math.max(1, Number(options.connections) || 16)));
          const args = ['--input-file=-', '--dir', path.dirname(target), '--no-conf=true', '--continue=true', '--auto-file-renaming=false', '--file-allocation=none', '--max-tries=5', '--retry-wait=3', '--timeout=60', '--connect-timeout=30', '--disable-ipv6=true', '--show-console-readout=false', '--summary-interval=0', '--download-result=hide', '--console-log-level=error', '--enable-color=false', '--user-agent=HuggingFaceDownloader/0.3'];
          const lines = [prepared.url, `  out=${path.basename(partial)}`, `  split=${connections}`, `  max-connection-per-server=${connections}`, '  min-split-size=1M', `  max-redirect=${prepared.maxRedirect}`];
          if (file.sha256) lines.push(`  checksum=sha-256=${file.sha256}`);
          for (const header of prepared.headers || []) lines.push(`  header=${header}`);
          const child = this.spawnProcess(executable, args, { windowsHide: true, stdio: ['pipe','ignore','ignore'] });
          this.child = child;
          let closed = false; let result; let settled = false;
          const completion = new Promise(resolve => {
            const finish = value => { if (settled) return; settled = true; closed = true; result = value; resolve(value); };
            child.once('error', error => finish({ error }));
            child.once('close', (code, signal) => finish({ code, signal }));
          });
          // If aria2 is missing or dies before it reads the manifest, this write
          // fails with EPIPE/ENOENT. An unhandled 'error' on a stream is a hard
          // crash of the whole app, and the child's own 'error'/'close' event
          // already reports the real problem, so swallow it here.
          // node's own stdin is null unless stdio[0] is a pipe, so this is
          // guarded rather than assumed.
          child.stdin?.on?.('error', () => {});
          child.stdin.end(lines.join('\n') + '\n');
          file.status = 'downloading'; file.error = ''; this.publish();
          let previous = 0; let previousAt = Date.now();
          while (!closed) {
            if (this.pausing) try { child.kill(); } catch {}
            await Promise.race([completion, delay(500)]);
            let bytes = 0; try { bytes = fs.statSync(partial).size; } catch {}
            const now = Date.now();
            file.completed = bytes;
            file.speed = Math.max(0, (bytes - previous) / Math.max(0.001, (now - previousAt) / 1000));
            previous = bytes; previousAt = now; this.publish();
          }
          await completion; this.child = null; file.speed = 0;
          if (this.pausing) { file.status = 'paused'; this.publish(); break; }
          if (result.error) throw new Error('Could not start aria2. Check its location in Settings.');
          if (result.code !== 0) throw new Error(describeAria2Error(result.code));
          file.status = 'verifying'; this.publish();
          if (!(await finishedPartial(partial, file))) throw new Error('The downloaded file failed its size or SHA-256 verification. The partial file was kept for inspection.');
          fs.renameSync(partial, target);
          file.status = 'complete'; file.completed = fs.statSync(target).size; this.publish();
        } catch (error) {
          if (this.pausing) break;
          file.status = 'error'; file.speed = 0; file.error = error.message; failures.push(file); this.publish();
        }
      }
      if (this.pausing) this.job.status = 'paused';
      else if (failures.length) {
        this.job.status = 'error';
        this.job.error = `${failures.length} of ${this.job.files.length} file(s) failed. ${failures[0].error} Use Resume / retry to attempt just the failures.`;
      } else this.job.status = 'complete';
    } finally { releaseLock(lock); }
  }
}

module.exports = { Transfer, describeAria2Error, hashFile, fileMatches, finishedPartial, neededBytes };
