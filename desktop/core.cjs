const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function safePath(value) {
  if (typeof value !== 'string' || !value || path.win32.isAbsolute(value) || /[\\:<>"|?*\x00-\x1f]/.test(value) ||
    value.split('/').some(s => !s || s === '.' || s === '..' || /[. ]$/.test(s) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(s))) throw new Error('This repository contains a file path Windows cannot safely save.');
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
  return `https://huggingface.co/${info.kind === 'models' ? '' : info.kind + '/'}${info.repo}/resolve/${encodeURIComponent(info.rev)}/${encodePath(file)}?download=true`;
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
  const scoped = files.filter(f => !info.subpath || (info.isFile ? f.path === info.subpath : f.path.startsWith(info.subpath + '/')));
  return { info, files: scoped, bundles: bundles(scoped.filter(f => /\.gguf$/i.test(f.path) && !companionKind(f.path))), vision: bundles(files.filter(f => companionKind(f.path) === 'vision')), mtp: bundles(files.filter(f => companionKind(f.path) === 'mtp')) };
}
async function listRepo(input, token = '', fetcher = fetch) {
  const info = parseLink(input);
  let next = `https://huggingface.co/api/${info.kind}/${info.repo}/tree/${encodeURIComponent(info.rev)}?recursive=true&expand=false`;
  const files = []; let pages = 0;
  while (next) {
    if (++pages > 100) throw new Error('This repository is too large to list completely. Use a smaller repository.');
    const url = new URL(next);
    if (url.origin !== 'https://huggingface.co') throw new Error('Unexpected file-list destination.');
    const requestOptions = { headers: { 'User-Agent': 'HuggingFaceDownloader/0.2', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(30000), redirect: 'manual' };
    let response;
    let requestUrl = url;
    for (let redirectCount = 0; ; redirectCount++) {
      const parsedRequestUrl = new URL(requestUrl);
      if (parsedRequestUrl.origin !== 'https://huggingface.co') throw new Error('Unexpected file-list destination.');
      response = await fetcher(parsedRequestUrl, requestOptions);
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      if (redirectCount >= 5) throw new Error('Hugging Face redirected the file listing too many times.');
      const location = response.headers.get('location');
      if (!location) throw new Error('Hugging Face returned an incomplete redirect.');
      const nextUrl = new URL(location, parsedRequestUrl);
      if (nextUrl.origin !== 'https://huggingface.co') throw new Error('Unexpected file-list destination.');
      requestUrl = nextUrl.toString();
    }
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Access denied. Add a read token in Settings and accept any model access terms on Hugging Face.' : response.status === 404 ? 'Repository or branch not found. Check the link.' : `Hugging Face returned HTTP ${response.status}. Try again shortly.`);
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error('Unexpected repository listing.');
    for (const f of page) if (f.type === 'file') { safePath(f.path); files.push({ path: f.path, size: Number(f.size) || 0 }); }
    next = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] || '';
  }
  if (!files.length) throw new Error('No files found in this repository.');
  return { ...catalog(info, files), allFiles: files };
}
function readToken(env = process.env) {
  for (const key of ['HF_TOKEN','HUGGING_FACE_HUB_TOKEN','HUGGINGFACE_TOKEN']) if (env[key]?.trim()) return env[key].trim();
  const filename = env.HF_TOKEN_PATH || path.join(env.HF_HOME || path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'huggingface'), 'token');
  try { return fs.readFileSync(filename, 'utf8').trim(); } catch { return ''; }
}
function findAria(explicit, root) {
  if (explicit) { if (fs.existsSync(explicit) && fs.statSync(explicit).isFile() && /\.exe$/i.test(explicit)) return path.resolve(explicit); throw new Error('The selected aria2 executable was not found. Choose aria2c.exe in Settings.'); }
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
module.exports = { safePath, parseLink, downloadUrl, quantName, bits, companionKind, bundles, catalog, listRepo, readToken, findAria };
