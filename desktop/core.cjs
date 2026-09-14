const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const https = require('node:https');

const HF_ORIGIN = 'https://huggingface.co';
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

function headerValue(headers, name) {
  const value = headers[String(name).toLowerCase()];
  return Array.isArray(value) ? value.join(', ') : value == null ? null : String(value);
}

// Electron's global fetch does not expose a way to require IPv4. The desktop
// app uses this small HTTPS adapter for Hugging Face metadata instead.
function fetchIPv4(input, options = {}) {
  return new Promise((resolve, reject) => {
    const url = input instanceof URL ? input : new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password) return reject(new Error('Only credential-free HTTPS URLs are allowed.'));
    const request = https.request(url, {
      method: options.method || 'GET', headers: options.headers, family: 4,
      timeout: 30000, rejectUnauthorized: true
    }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) request.destroy(new Error('Hugging Face returned an unexpectedly large response.'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode || 0,
          ok: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300,
          headers: { get: name => headerValue(response.headers, name) },
          json: async () => JSON.parse(body),
          text: async () => body
        });
      });
    });
    request.on('timeout', () => request.destroy(new Error('Hugging Face request timed out.')));
    request.on('error', reject);
    if (options.signal) {
      if (options.signal.aborted) request.destroy(options.signal.reason);
      else options.signal.addEventListener('abort', () => request.destroy(options.signal.reason), { once: true });
    }
    request.end();
  });
}

function validToken(value) {
  const token = String(value || '').trim();
  if (/[\x00-\x1f\x7f]/.test(token) || token.length > 4096) throw new Error('The Hugging Face token contains invalid characters.');
  return token;
}

// Bidirectional and zero-width formatting characters are legal in a filename and render
// as nothing, so "payload‮gpj.exe" is shown by this app, by Explorer, and by every
// file dialog as "payloadexe.jpg". A user who believes they picked an image runs a binary.
const SPOOFING = /[​-‏‪-‮⁦-⁩﻿]/;
function safePath(value) {
  if (typeof value === 'string' && SPOOFING.test(value)) throw new Error('This repository contains a file name that uses text-direction characters to disguise its extension.');
  if (typeof value !== 'string' || !value || path.win32.isAbsolute(value) || /[\\:<>"|?*\x00-\x1f]/.test(value) ||
    value.split('/').some(s => !s || s.length > 255 || s === '.' || s === '..' || /[. ]$/.test(s) || /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM(?:[1-9]|[\u00b9\u00b2\u00b3])|LPT(?:[1-9]|[\u00b9\u00b2\u00b3]))(?:\.|$)/i.test(s))) throw new Error('This repository contains a file path Windows cannot safely save.');
  return value;
}
function parseLink(input) {
  let value = String(input || '').trim();
  if (!value) throw new Error('Paste a Hugging Face model link or owner/repository.');
  if (!/^https?:\/\//i.test(value)) value = 'https://' + (/^(www\.)?(huggingface\.co|hf\.co)\//i.test(value) ? value : 'huggingface.co/' + value);
  const url = new URL(value);
  if (!['huggingface.co', 'www.huggingface.co', 'hf.co', 'www.hf.co'].includes(url.hostname) || url.username || url.password) throw new Error('Use a link from huggingface.co.');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  let kind = 'models';
  if (['datasets', 'spaces'].includes(parts[0])) kind = parts.shift();
  const owner = parts.shift(); const name = parts[0] && !['blob', 'resolve', 'tree', 'raw'].includes(parts[0]) ? parts.shift() : '';
  const repo = [owner, name].filter(Boolean).join('/');
  if (!/^[\w-][\w.-]*(\/[\w-][\w.-]*)?$/.test(repo)) throw new Error('Use a valid owner/repository name.');
  let rev = 'main', subpath = '', isFile = false;
  if (parts.length) {
    const verb = parts.shift();
    if (!['blob','resolve','tree','raw'].includes(verb)) throw new Error('Use a repository, folder, or file link.');
    rev = parts.shift() || 'main';
    if (rev === 'refs' && parts.length >= 2) rev += '/' + parts.splice(0, 2).join('/');
    subpath = parts.join('/');
    if (subpath) safePath(subpath);
    isFile = verb !== 'tree' && !!subpath;
  }
  return { repo, kind, rev, subpath, isFile };
}
const encodePath = p => p.split('/').map(encodeURIComponent).join('/');
function downloadUrl(info, file) {
  safePath(file);
  const revision = info.commit || info.rev;
  return `${HF_ORIGIN}/${info.kind === 'models' ? '' : info.kind + '/'}${info.repo}/resolve/${encodePath(revision)}/${encodePath(file)}?download=true`;
}
function quantName(p) {
  const re = /(?:^|[^a-z0-9])((?:UD-)?(?:IQ[1-8](?:_[A-Z0-9]+)*|Q[1-8](?:_[A-Z0-9]+)*|TQ[12]_0|MXFP4|NVFP4|BF16|FP16|F16|F32))(?![a-z0-9])/i;
  for (const part of [p.split('/').at(-1), ...p.split('/')]) { const match = part.match(re); if (match) return match[1].toUpperCase(); }
  return '';
}
function bits(q) { const m = q.match(/(?:IQ|TQ|Q)([1-8])/); return m ? Number(m[1]) : /FP4/.test(q) ? 4 : /16/.test(q) ? 16 : /32/.test(q) ? 32 : 0; }
function companionKind(p) {
  if (!/\.gguf$/i.test(p)) return '';
  if (/(^|\/)(mmproj|vision|vision_encoder|projector)([-_./]|$)/i.test(p)) return 'vision';
  if (/(^|\/)(mtp|draft|draft_model|nextn)([-_./]|$)/i.test(p)) return 'mtp';
  return '';
}
function bundles(files) {
  const groups = new Map();
  for (const f of files) { const key = f.path.replace(/-\d{5}-of-\d{5}(?=\.gguf$)/i, ''); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(f); }
  return [...groups].map(([name, members]) => {
    const shards = members.map(f => f.path.match(/-(\d{5})-of-(\d{5})\.gguf$/i)).filter(Boolean);
    const expected = shards.length ? Number(shards[0][2]) : 1;
    const complete = !shards.length || (shards.length === members.length && expected === members.length && shards.every(s => Number(s[2]) === expected) && new Set(shards.map(s => Number(s[1]))).size === expected && shards.every(s => Number(s[1]) >= 1 && Number(s[1]) <= expected));
    return { name, quant: quantName(name), bits: bits(quantName(name)), files: members, size: members.reduce((n, f) => n + (f.size || 0), 0), complete };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
function catalog(info, files) {
  let scoped = files.filter(f => !info.subpath || (info.isFile ? f.path === info.subpath : f.path.startsWith(info.subpath + '/')));
  if (info.isFile && /-\d{5}-of-\d{5}\.gguf$/i.test(info.subpath)) {
    const key = info.subpath.replace(/-\d{5}-of-\d{5}(?=\.gguf$)/i, '');
    scoped = files.filter(f => f.path.replace(/-\d{5}-of-\d{5}(?=\.gguf$)/i, '') === key);
  }
  return { info, files: scoped, bundles: bundles(scoped.filter(f => /\.gguf$/i.test(f.path) && !companionKind(f.path))), vision: bundles(files.filter(f => companionKind(f.path) === 'vision')), mtp: bundles(files.filter(f => companionKind(f.path) === 'mtp')) };
}
const isSafePath = p => { try { safePath(p); return true; } catch { return false; } };
function windowsPathKey(value) { return value.normalize('NFC').toLocaleLowerCase('en-US'); }
function withoutWindowsCollisions(candidates) {
  const exact = new Map();
  for (const file of candidates) if (!exact.has(file.path)) exact.set(file.path, file);
  const groups = new Map();
  for (const file of exact.values()) {
    const key = windowsPathKey(file.path);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }
  const files = []; let skipped = 0;
  for (const group of groups.values()) {
    if (group.length > 1) skipped += group.length;
    else files.push(group[0]);
  }
  const fileKeys = new Set(files.map(f => windowsPathKey(f.path)));
  const unsafeParents = new Set();
  for (const file of files) {
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) if (fileKeys.has(windowsPathKey(parts.slice(0, i).join('/')))) unsafeParents.add(windowsPathKey(file.path));
  }
  return { files: files.filter(f => !unsafeParents.has(windowsPathKey(f.path))), skipped: skipped + unsafeParents.size };
}
async function listRepo(input, token = '', fetcher = fetchIPv4) {
  const info = parseLink(input);
  token = validToken(token);
  let next = `${HF_ORIGIN}/api/${info.kind}/${info.repo}/tree/${encodePath(info.rev)}?recursive=true&expand=false`;
  const candidates = []; let pages = 0, skipped = 0, commit = '';
  while (next) {
    if (++pages > 100) throw new Error('This repository is too large to list completely. Use a smaller repository.');
    const url = new URL(next);
    if (url.origin !== HF_ORIGIN || url.username || url.password) throw new Error('Unexpected file-list destination.');
    const requestOptions = { headers: { 'User-Agent': 'HuggingFaceDownloader/0.2', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(30000), redirect: 'manual' };
    let response;
    let requestUrl = url;
    for (let redirectCount = 0; ; redirectCount++) {
      const parsedRequestUrl = new URL(requestUrl);
      if (parsedRequestUrl.origin !== HF_ORIGIN || parsedRequestUrl.username || parsedRequestUrl.password) throw new Error('Unexpected file-list destination.');
      response = await fetcher(parsedRequestUrl, requestOptions);
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      if (redirectCount >= 5) throw new Error('Hugging Face redirected the file listing too many times.');
      const location = response.headers.get('location');
      if (!location) throw new Error('Hugging Face returned an incomplete redirect.');
      const nextUrl = new URL(location, parsedRequestUrl);
      if (nextUrl.origin !== HF_ORIGIN || nextUrl.username || nextUrl.password) throw new Error('Unexpected file-list destination.');
      requestUrl = nextUrl.toString();
    }
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Access denied. Add a read token in Settings and accept any model access terms on Hugging Face.' : response.status === 404 ? 'Repository or branch not found. Check the link.' : `Hugging Face returned HTTP ${response.status}. Try again shortly.`);
    const pageCommit = String(response.headers.get('x-repo-commit') || '').toLowerCase();
    if (pageCommit) {
      if (!/^[a-f0-9]{40,64}$/.test(pageCommit)) throw new Error('Hugging Face returned an invalid repository revision.');
      if (commit && commit !== pageCommit) throw new Error('The repository changed while it was being listed. Reload it and try again.');
      commit = pageCommit;
    }
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error('Unexpected repository listing.');
    // One file Windows cannot name must not make the whole repository
    // unloadable: skip it and let the user download everything else. The
    // download path re-checks every selected file, so nothing unsafe slips by.
    for (const f of page) if (f.type === 'file') {
      const digest = String(f.lfs?.sha256 || f.lfs?.oid || '').replace(/^sha256:/i, '');
      if (isSafePath(f.path)) candidates.push({ path: f.path, size: Number(f.size) || 0, sha256: /^[a-f0-9]{64}$/i.test(digest) ? digest.toLowerCase() : '' });
      else skipped++;
    }
    next = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] || '';
  }
  const collisionCheck = withoutWindowsCollisions(candidates);
  skipped += collisionCheck.skipped;
  const files = collisionCheck.files;
  if (!files.length) throw new Error(skipped ? `None of the ${skipped} file(s) in this repository can be saved safely on Windows.` : 'No files found in this repository.');
  if (commit) info.commit = commit;
  return { ...catalog(info, files), allFiles: files, skipped };
}
async function resolveDownload(info, file, token = '', fetcher = fetchIPv4) {
  token = validToken(token);
  let current = new URL(downloadUrl(info, file));
  for (let redirects = 0; redirects <= 10; redirects++) {
    if (current.protocol !== 'https:' || current.username || current.password) throw new Error('Hugging Face returned an unsafe download address.');
    // Once Hugging Face supplies a signed CDN URL, stop resolving. aria2 can
    // follow later redirects without ever receiving the bearer token.
    if (current.origin !== HF_ORIGIN) return { url: current.toString(), headers: [], maxRedirect: 10 };
    const response = await fetcher(current, {
      method: 'HEAD', redirect: 'manual',
      headers: { 'User-Agent': 'HuggingFaceDownloader/0.3', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(30000)
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === 10) throw new Error('Hugging Face redirected the download too many times.');
      const location = response.headers.get('location');
      if (!location) throw new Error('Hugging Face returned an incomplete download redirect.');
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Access denied. Check your Hugging Face token and model access.' : response.status === 404 ? 'File or revision not found. Reload the repository listing.' : `Hugging Face returned HTTP ${response.status} while preparing the download.`);
    // Small private files can be served directly by huggingface.co. In that
    // case aria2 gets the header, but redirects are disabled so it cannot be
    // forwarded to another host.
    return { url: current.toString(), headers: token ? [`Authorization: Bearer ${token}`] : [], maxRedirect: 0 };
  }
  throw new Error('Hugging Face redirected the download too many times.');
}
function readToken(env = process.env) {
  for (const key of ['HF_TOKEN','HUGGING_FACE_HUB_TOKEN','HUGGINGFACE_TOKEN']) if (env[key]?.trim()) return validToken(env[key]);
  const filename = env.HF_TOKEN_PATH || path.join(env.HF_HOME || path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'huggingface'), 'token');
  try { return validToken(fs.readFileSync(filename, 'utf8')); } catch (error) { if (error?.code === 'ENOENT') return ''; throw error; }
}
// The Settings field is free text, and whatever it names is spawned. Existing-and-ends-
// in-.exe was not enough: it accepted "\\\\host\\share\\aria2c.exe", so a path typed or
// pasted in could run a binary off someone else's machine, and Windows would authenticate
// to that share on the way. A download engine is a program on a local drive.
function localExecutable(value) {
  if (typeof value !== 'string' || !value || value.length > 32767) return false;
  if (/[\u0000-\u001f"<>|*?]/.test(value)) return false;
  if (value.startsWith('\\\\') || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  if (!/^[A-Za-z]:[\\/]/.test(value)) return false;
  if (value.split(/[\\/]/).includes('..')) return false;
  return /\.exe$/i.test(value);
}
function findAria(explicit, root) {
  if (explicit) {
    if (!localExecutable(explicit)) throw new Error('Choose aria2c.exe by its full path on a local drive, for example C:\\Tools\\aria2\\aria2c.exe. Network locations are not accepted.');
    if (fs.existsSync(explicit) && fs.statSync(explicit).isFile()) return path.resolve(explicit);
    throw new Error('The selected aria2 executable was not found. Choose aria2c.exe in Settings.');
  }
  const candidates = [path.join(root, 'bin', 'aria2c.exe'), ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(p => path.join(p, 'aria2c.exe'))];
  for (const [key, rel] of [['LOCALAPPDATA','Microsoft/WinGet/Links/aria2c.exe'],['ProgramFiles','aria2/aria2c.exe'],['ProgramData','chocolatey/bin/aria2c.exe']]) if (process.env[key]) candidates.push(path.join(process.env[key], rel));
  candidates.push(path.join(os.homedir(),'scoop','shims','aria2c.exe'));
  const packages = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA,'Microsoft','WinGet','Packages');
  if (packages && fs.existsSync(packages)) for (const dir of fs.readdirSync(packages).filter(d => /^aria2\./i.test(d))) {
    const walk = (folder, depth) => { if (depth > 3) return; for (const e of fs.readdirSync(folder, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(folder,e.name),depth+1); else if (e.name === 'aria2c.exe') candidates.push(path.join(folder,e.name)); } };
    try { walk(path.join(packages,dir),0); } catch {}
  }
  return candidates.find(p => fs.existsSync(p) && fs.statSync(p).isFile()) || '';
}
module.exports = { localExecutable, safePath, isSafePath, parseLink, downloadUrl, resolveDownload, quantName, bits, companionKind, bundles, catalog, listRepo, readToken, findAria, validToken, fetchIPv4, withoutWindowsCollisions };
