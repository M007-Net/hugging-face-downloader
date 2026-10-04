const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createHash, randomUUID } = require('node:crypto');
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

function hashFile(filename, signal) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = fs.createReadStream(filename, { signal });
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

async function finishedPartial(filename, file, signal) {
  if (!(file.size > 0) && !file.sha256) return false;
  if (!fs.existsSync(filename)) return false;
  if (!file.sha256 && (fs.existsSync(filename + '.aria2') || fs.existsSync(filename + '.aria2__temp'))) return false;
  const stat = fs.statSync(filename);
  if (!stat.isFile() || (file.size > 0 && stat.size !== file.size)) return false;
  return !file.sha256 || (await hashFile(filename, signal)) === file.sha256;
}

// aria2 publishes progress in exactly one place: its own control file. Reading the
// .part file instead was wrong in a way that looked like a fault in the download.
// With sixteen connections each seeking to the start of its own segment, the first
// writes push the file to its full length within a second or two - so the bar ran
// to the end almost immediately, the percentage stuck at 100 while a tenth of the
// data was still coming, and the speed, a difference between two file sizes that
// could no longer change, read 0 B/s for the rest of the transfer.
//
// The control file carries a bitfield of completed pieces, which is the number that
// was wanted all along. Format, all big-endian:
//   u16 version | u32 extension | u32 infoHashLength | infoHash
//   u32 pieceLength | u64 totalLength | u64 uploadLength
//   u32 bitfieldLength | bitfield | u32 numInFlightPiece | in-flight pieces
const POPCOUNT = Array.from({ length: 256 }, (_, value) => { let bits = 0; for (let b = value; b; b >>= 1) bits += b & 1; return bits; });
function controlFileState(partial) {
  // aria2 normally renames the temporary save over .aria2. On some SMB shares
  // that rename fails, leaving a stale .aria2 beside a fresh .aria2__temp.
  // Read the newest valid save first, then fall back if it is half-written.
  const names = [partial + '.aria2', partial + '.aria2__temp']
    .map(name => { try { return { name, modified: fs.statSync(name).mtimeMs }; } catch { return null; } })
    .filter(Boolean).sort((a, b) => b.modified - a.modified);
  for (const { name } of names) {
    let buffer;
    try { buffer = fs.readFileSync(name); } catch { continue; }
    try {
      if (buffer.readUInt16BE(0) !== 1) continue;
      let at = 2 + 4;
      at += 4 + buffer.readUInt32BE(at);
      const pieceLength = buffer.readUInt32BE(at); at += 4;
      const totalLength = Number(buffer.readBigUInt64BE(at)); at += 8 + 8;
      const bitfieldLength = buffer.readUInt32BE(at); at += 4;
      const bitfield = buffer.subarray(at, at + bitfieldLength);
      if (!(pieceLength > 0) || !(totalLength > 0) || !Number.isSafeInteger(totalLength) || bitfield.length !== bitfieldLength || bitfieldLength !== Math.ceil(Math.ceil(totalLength / pieceLength) / 8) || buffer.length < at + bitfieldLength + 4) continue;
      let done = 0;
      for (const byte of bitfield) done += POPCOUNT[byte];
      // Every completed piece is a full pieceLength except the last, which is short
      // whenever the total is not an exact multiple of it.
      const count = Math.ceil(totalLength / pieceLength);
      const index = count - 1;
      const lastDone = index >= 0 && index >> 3 < bitfield.length && (bitfield[index >> 3] >> (7 - (index & 7))) & 1;
      const short = lastDone ? pieceLength - (totalLength - index * pieceLength) : 0;
      return { name, bytes:Math.min(totalLength, Math.max(0, done * pieceLength - short)) };
    } catch { /* a half-written save: try the other name, then fall back */ }
  }
  return null;
}
function controlFileBytes(partial) { return controlFileState(partial)?.bytes ?? null; }
// Falls back to the file size, capped at what the file is meant to be. That is the
// old measurement, kept for the moment before aria2 has written a control file and
// for any future version of it whose format this no longer understands.
function progressBytes(partial, file) {
  const exact = controlFileBytes(partial);
  let bytes = exact;
  if (bytes === null) { try { bytes = fs.statSync(partial).size; } catch { return 0; } }
  return file.size > 0 ? Math.min(bytes, file.size) : bytes;
}
function recoverControlFile(partial) {
  const control = partial + '.aria2';
  const temporary = control + '__temp';
  if (!fs.existsSync(partial) || !fs.existsSync(temporary)) return false;
  // aria2 1.37 can leave a valid temporary control file on a network share.
  // Without the canonical name it treats a sparse .part as a complete file and
  // fails its checksum instead of resuming. Preserve the temp and copy it only
  // when its bitfield can be read. Replace a stale canonical save as well.
  // The app verifies the final checksum after the queue finishes.
  if (controlFileState(partial)?.name !== temporary) return false;
  fs.copyFileSync(temporary, control);
  return true;
}
function aria2Size(value) {
  const match = /^([\d.]+)(B|KiB|MiB|GiB|TiB|PiB)$/.exec(value);
  if (!match) return null;
  const power = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'].indexOf(match[2]);
  const bytes = Number(match[1]) * 1024 ** power;
  return Number.isFinite(bytes) ? bytes : null;
}

// aria2's summary is its live accounting, independent of the .aria2 resume file.
// On some shares that file stops updating even while bytes keep arriving.
function aria2Progress(text) {
  const lines = [...text.matchAll(/\[#[0-9a-f]+\s+([\d.]+(?:B|KiB|MiB|GiB|TiB|PiB))\/([\d.]+(?:B|KiB|MiB|GiB|TiB|PiB))\([^)]*\)\s+CN:\d+\s+DL:([\d.]+(?:B|KiB|MiB|GiB|TiB|PiB))/gi)];
  if (!lines.length) return null;
  const last = lines[lines.length - 1];
  const completed = aria2Size(last[1]);
  const speed = aria2Size(last[3]);
  return completed === null || speed === null ? null : { completed, speed };
}
function rejectNestedLinks(destination, target) {
  const relative = path.relative(destination, path.dirname(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('The download path escaped the selected repository folder.');
  let current = destination;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`Refusing to write through a symbolic link or junction: ${current}`);
  }
  // The loop above covers the directories. The file itself, and the .part aria2 actually
  // opens, were never checked - so a link pre-planted at <dest>/<file>.part was followed.
  for (const leaf of [target, target + '.part']) {
    if (fs.existsSync(leaf) && fs.lstatSync(leaf).isSymbolicLink()) throw new Error(`Refusing to write through a symbolic link or junction: ${leaf}`);
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
    if (file.status === 'complete' || file.status === 'downloaded' || !(file.size > 0)) return sum;
    const partial = path.join(destination, ...file.path.split('/')) + '.part';
    let existing = 0;
    try { existing = controlFileBytes(partial) ?? fs.statSync(partial).size; } catch {}
    return sum + Math.max(0, file.size - existing);
  }, 0);
}

function ariaArguments(directory) {
  return ['--input-file=-', '--dir', directory, '--no-conf=true', '--continue=true', '--auto-save-interval=1', '--auto-file-renaming=false', '--file-allocation=none', '--max-tries=5', '--retry-wait=3', '--timeout=60', '--connect-timeout=30', '--disable-ipv6=true', '--show-console-readout=true', '--summary-interval=1', '--download-result=hide', '--console-log-level=error', '--enable-color=false', '--user-agent=HuggingFaceDownloader/0.3'];
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
      try { const saved = JSON.parse(fs.readFileSync(filename, 'utf8')); pid = Number(saved.pid); } catch {}
      let running = false;
      if (pid > 0) try { process.kill(pid, 0); running = true; } catch {}
      // Long downloads can legitimately run for days. Never remove a live
      // process's lock merely because its timestamp is old.
      if (running) throw new Error('Another downloader is already writing to this repository folder. If nothing is running, delete .hugging-face-downloader.lock in that folder.');
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
  // Listeners write last-download.json on every tick, and that write can fail for
  // reasons that have nothing to do with the transfer - antivirus holding the temp file,
  // a full disk, a roaming profile. Letting that throw out of emit() unwound into the
  // per-file catch below, which moved on to the next file without killing the aria2 that
  // was still running, so the process was orphaned and kept writing to the same .part.
  publish() { try { this.emit('update', this.job); } catch { /* a broken listener must not fail the download */ } }
  start(job, executable, options, token) {
    if (this.busy) throw new Error('A download is already running in this app.');
    if (!job.files?.length) throw new Error('Choose at least one file.');
    for (const file of job.files) safePath(file.path);
    this.busy = true; this.pausing = false; this.abort = new AbortController();
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
      this.abort.abort();
      if (this.child) try { this.child.kill(); } catch {}
      await this.done;
    }
    return this.job;
  }
  async run(executable, options, token) {
    const lock = acquireLock(this.job.destination);
    try {
      this.job.status = 'starting'; this.publish();
      for (const file of this.job.files) {
        const target = path.join(this.job.destination, ...file.path.split('/'));
        if (target.length > 32760) throw new Error(`The destination path is too long for Windows: ${file.path}`);
        rejectNestedLinks(this.job.destination, target);
        // Leave existing files for the final checking phase too. Reading a large
        // file from a network share here would stall the next download.
        if (fs.existsSync(target) && !fs.existsSync(target + '.aria2') && !fs.existsSync(target + '.aria2__temp')) {
          const stat = fs.statSync(target);
          if (stat.isFile() && (!file.size || stat.size === file.size)) {
            file.status = 'downloaded'; file.completed = stat.size;
          }
        }
      }
      const free = availableBytes(this.job.destination);
      const needed = neededBytes(this.job.files, this.job.destination);
      if (free !== null && needed > free) throw new Error(`Not enough free disk space. The selected files still need ${needed.toLocaleString()} bytes, but only ${free.toLocaleString()} bytes are available.`);
      this.job.status = 'downloading'; this.publish();
      const failures = [];
      for (const file of this.job.files) {
        if (this.pausing) break;
        if (file.status === 'downloaded') continue;
        const target = path.join(this.job.destination, ...file.path.split('/'));
        const partial = target + '.part';
        fs.mkdirSync(path.dirname(target), { recursive: true });
        rejectNestedLinks(this.job.destination, target);
        recoverControlFile(partial);
        if (!fs.existsSync(partial) && fs.existsSync(target) && fs.existsSync(target + '.aria2')) {
          fs.renameSync(target, partial);
          fs.renameSync(target + '.aria2', partial + '.aria2');
        }
        file.completed = controlFileBytes(partial) ?? 0;
        // A file downloaded before the pause may only be awaiting the queue's
        // checking phase. Do not resolve its URL or ask aria2 to fetch it again.
        if (fs.existsSync(partial) && !fs.existsSync(partial + '.aria2') && !fs.existsSync(partial + '.aria2__temp') && file.size > 0 && fs.statSync(partial).size === file.size) {
          file.status = 'downloaded'; file.completed = file.size; this.publish(); continue;
        }
        try {
          const prepared = await this.resolveForFile(this.job.info, file.path, token, undefined, this.abort.signal);
          if (this.pausing) { file.status = 'paused'; break; }
          if ((prepared.headers || []).some(header => /^\s*authorization\s*:/i.test(header))) {
            throw new Error('Refusing to pass an Authorization header to aria2. Resolve the file to a signed download URL first.');
          }
          const connections = String(Math.min(16, Math.max(1, Number(options.connections) || 16)));
          const args = ariaArguments(path.dirname(target));
          const lines = [prepared.url, `  out=${path.basename(partial)}`, `  split=${connections}`, `  max-connection-per-server=${connections}`, '  min-split-size=1M'];
          for (const header of prepared.headers || []) lines.push(`  header=${header}`);
          // stderr was discarded, which made --console-log-level=error dead weight and
          // turned every code aria2 reports outside the four mapped below into an
          // unactionable "aria2 code 1". Keep the tail of it for the error message.
          const child = this.spawnProcess(executable, args, { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
          let stderrTail = '';
          child.stderr?.setEncoding('utf8');
          child.stderr?.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-4096); });
          let stdoutTail = '';
          let live = null;
          child.stdout?.setEncoding('utf8');
          child.stdout?.on('data', chunk => {
            stdoutTail = (stdoutTail + chunk).slice(-8192);
            const parsed = aria2Progress(stdoutTail);
            if (parsed) live = { ...parsed, at: Date.now() };
          });
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
          // aria2 rewrites the control file once a second, so a speed taken between
          // two consecutive half-second polls alternates between nothing and double.
          // Averaging across a short trailing window reports what the transfer is
          // actually doing rather than which side of a save the poll landed on.
          const samples = [{ at: Date.now(), bytes: file.completed }];
          while (!closed) {
            if (this.pausing) try { child.kill(); } catch {}
            await Promise.race([completion, delay(500)]);
            const now = Date.now();
            // A sparse .part can have its full final length after only a few
            // segments arrive, so its file size is never a live progress source.
            const saved = controlFileBytes(partial);
            const bytes = live && now - live.at < 3000
              ? Math.max(file.completed, Math.min(file.size || Infinity, live.completed))
              : saved === null ? file.completed : Math.max(file.completed, Math.min(file.size || Infinity, saved));
            samples.push({ at: now, bytes });
            while (samples.length > 2 && now - samples[0].at > 5000) samples.shift();
            const seconds = (now - samples[0].at) / 1000;
            file.completed = bytes;
            file.speed = live && now - live.at < 3000 ? live.speed
              : seconds > 0 ? Math.max(0, (bytes - samples[0].bytes) / seconds) : 0;
            this.publish();
          }
          await completion; this.child = null; file.speed = 0;
          if (this.pausing) { file.status = 'paused'; this.publish(); break; }
          if (result.error) throw new Error('Could not start aria2. Check its location in Settings.');
          if (result.code !== 0) {
            const detail = stderrTail.trim().split(/[\r\n]+/).filter(Boolean).slice(-2).join(' ');
            throw new Error(describeAria2Error(result.code) + (detail ? ` aria2 said: ${detail}` : ''));
          }
          // Hash the completed queue once, after transfers finish. Keep the staged
          // file in place so pause/retry never exposes an unchecked final file.
          file.status = 'downloaded'; file.completed = fs.statSync(partial).size; this.publish();
          // Successful aria2 exits can leave stale temporary saves on Windows
          // and SMB. They no longer describe an unfinished transfer; retaining
          // them causes the next resume to download this file again.
          for (const leftover of [partial + '.aria2', partial + '.aria2__temp']) fs.rmSync(leftover, { force:true });
        } catch (error) {
          // Whatever went wrong, this file's aria2 must not outlive it: the next
          // iteration overwrites this.child, and an unreferenced child keeps running,
          // racing the retry for the same .part file and surviving app exit.
          if (this.child) { try { this.child.kill(); } catch { /* already gone */ } this.child = null; }
          if (this.pausing) break;
          file.status = 'error'; file.speed = 0; file.error = error.message; failures.push(file); this.publish();
        }
      }
      if (!this.pausing) {
        this.job.status = 'verifying'; this.publish();
        for (const file of this.job.files) {
          if (this.pausing) break;
          if (file.status !== 'downloaded') continue;
          const target = path.join(this.job.destination, ...file.path.split('/'));
          const partial = target + '.part';
          const staged = fs.existsSync(partial) ? partial : target;
          file.status = 'verifying'; this.publish();
          try {
            if (!(await finishedPartial(staged, file, this.abort.signal))) {
              // Keep bad bytes for inspection under a different name. Otherwise
              // --continue or the existing-file shortcut reuses them on every retry.
              if (fs.existsSync(staged + '.aria2') || fs.existsSync(staged + '.aria2__temp')) throw new Error('The file still has download resume state. Resume / retry to finish it.');
              const rejected = staged + '.failed-' + randomUUID();
              fs.renameSync(staged, rejected);
              throw new Error(`The downloaded file failed its size or SHA-256 check. It was kept at ${rejected}.`);
            }
            if (this.pausing) { file.status = 'downloaded'; break; }
            if (staged === partial) fs.renameSync(partial, target);
            for (const leftover of [partial + '.aria2', partial + '.aria2__temp']) try { fs.rmSync(leftover, { force: true }); } catch {}
            file.status = 'complete'; file.completed = fs.statSync(target).size; this.publish();
          } catch (error) {
            if (this.pausing) { file.status = 'downloaded'; break; }
            file.status = 'error'; file.error = error.message; failures.push(file); this.publish();
          }
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

module.exports = { Transfer, describeAria2Error, hashFile, fileMatches, finishedPartial, neededBytes, controlFileBytes, progressBytes, recoverControlFile, aria2Progress, ariaArguments };
