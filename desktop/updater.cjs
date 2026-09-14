// Update checking against GitHub Releases.
//
// The repository is configured in one place - the "repository" field of
// package.json - and until it is filled in every function here reports
// "not configured" rather than reaching the network. See README.md, "Turning on
// the updater".
//
// The installer this project publishes is not code-signed, so an update is only
// ever as trustworthy as the bytes we can verify. Two rules follow from that and
// are enforced below:
//
//   1. An asset is only accepted if the release notes publish its SHA-256 and
//      the downloaded file matches. No digest, no install.
//   2. Nothing is executed automatically. The main process downloads on an
//      explicit click and runs the installer only on a second, separate one.

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { createHash } = require('node:crypto');

const GITHUB_API = 'https://api.github.com';
// GitHub serves release assets from api.github.com, then redirects to its
// object storage. Anything outside this list means the release was tampered
// with or the API changed, and either way we stop.
const ASSET_HOSTS = new Set(['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const PLACEHOLDER_OWNER = 'YOUR_GITHUB_USERNAME';
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_ASSET_BYTES = 512 * 1024 * 1024;
const USER_AGENT = 'HuggingFaceDownloader-Updater';

// "owner/repo", "https://github.com/owner/repo", "git+https://github.com/owner/repo.git"
function parseRepository(value) {
  const raw = String((value && value.url) || value || '').trim();
  if (!raw) return null;
  const cleaned = raw.replace(/^git\+/, '').replace(/\.git$/, '');
  const match = cleaned.match(/^(?:https?:\/\/(?:www\.)?github\.com\/)?([\w.-]+)\/([\w.-]+)$/i);
  if (!match) return null;
  const [, owner, repo] = match;
  // [\w.-] admits "." and "..", which the URL parser would then collapse when building
  // the api.github.com path. The host pin makes that harmless today, but a traversal
  // primitive has no business sitting in URL construction.
  if ([owner, repo].some(part => part === '.' || part === '..')) return null;
  if (owner === PLACEHOLDER_OWNER) return null;
  return { owner, repo };
}

// Anchored at both ends. Without the trailing $ a tag like
// "0.9.0-x/../../../Windows/Start Menu/Programs/Startup/payload" parsed as a valid
// 0.9.0 prerelease, and the whole raw string was carried through as `version` into a
// filesystem path. The version a release advertises is server data, not a path.
function parseVersion(value) {
  const match = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ? match[4].split('.') : [] };
}

// Returns > 0 when `a` is newer than `b`. Follows semver: a prerelease sorts
// before its own release, so 0.4.0-beta.1 does not look like an upgrade over
// 0.4.0, and identifiers compare numerically when both sides are numeric.
function compareVersions(a, b) {
  const left = parseVersion(a); const right = parseVersion(b);
  if (!left || !right) return 0;
  for (const key of ['major', 'minor', 'patch']) if (left[key] !== right[key]) return left[key] - right[key];
  if (!left.pre.length && !right.pre.length) return 0;
  if (!left.pre.length) return 1;
  if (!right.pre.length) return -1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i]; const y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const bothNumeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    if (bothNumeric) { if (Number(x) !== Number(y)) return Number(x) - Number(y); }
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// Release notes are free text, so the digest is looked up by filename rather
// than by position. Both `<name>  <hash>` and `<hash>  <name>` are accepted,
// which covers the two orders `Get-FileHash` and `sha256sum` produce.
function digestFor(notes, filename) {
  const text = String(notes || '');
  const name = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`${name}[^0-9a-f]{1,40}([0-9a-f]{64})`, 'i'),
    new RegExp(`([0-9a-f]{64})[^0-9a-f]{1,40}${name}`, 'i')
  ];
  for (const pattern of patterns) { const match = text.match(pattern); if (match) return match[1].toLowerCase(); }
  return '';
}

function requestJSON(url, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.hostname !== 'api.github.com' || target.username || target.password) {
      return reject(new Error('Update checks only talk to api.github.com.'));
    }
    const request = https.request(target, {
      method: 'GET', timeout, rejectUnauthorized: true,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
    }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_METADATA_BYTES) request.destroy(new Error('GitHub returned an unexpectedly large response.'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        const status = response.statusCode || 0;
        if (status === 404) return reject(new Error('No published release was found for this repository yet.'));
        if (status === 403 || status === 429) return reject(new Error('GitHub is rate-limiting update checks right now. Try again later.'));
        if (status < 200 || status >= 300) return reject(new Error(`GitHub returned HTTP ${status} while checking for updates.`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('GitHub returned a response this app could not read.')); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('The update check timed out.')));
    request.on('error', reject);
    request.end();
  });
}

async function checkForUpdate({ repository, currentVersion, request = requestJSON } = {}) {
  const target = parseRepository(repository);
  if (!target) return { configured: false, available: false };
  const release = await request(`${GITHUB_API}/repos/${target.owner}/${target.repo}/releases/latest`);
  if (!release || typeof release !== 'object' || Array.isArray(release)) throw new Error('GitHub returned an unexpected release listing.');
  if (release.draft) return { configured: true, available: false, currentVersion };
  const version = String(release.tag_name || release.name || '').trim();
  if (!parseVersion(version)) throw new Error('The latest release does not use a recognizable version number.');
  const page = String(release.html_url || `https://github.com/${target.owner}/${target.repo}/releases`);
  const base = { configured: true, currentVersion, version: version.replace(/^v/i, ''), notes: String(release.body || ''), releaseUrl: page, prerelease: !!release.prerelease };
  if (compareVersions(version, currentVersion) <= 0) return { ...base, available: false };

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const installer = assets.find(a => a && typeof a.name === 'string' && /\.exe$/i.test(a.name) && !/\.blockmap$/i.test(a.name));
  if (!installer) return { ...base, available: true, asset: null, reason: 'This release publishes no Windows installer. Download it from the release page.' };

  let assetUrl;
  try { assetUrl = new URL(String(installer.browser_download_url || '')); } catch { assetUrl = null; }
  if (!assetUrl || assetUrl.protocol !== 'https:' || !ASSET_HOSTS.has(assetUrl.hostname) || assetUrl.username || assetUrl.password) {
    return { ...base, available: true, asset: null, reason: 'The installer for this release is hosted somewhere this app will not download from. Use the release page.' };
  }
  const sha256 = digestFor(release.body, installer.name);
  if (!sha256) return { ...base, available: true, asset: null, reason: 'This release does not publish a SHA-256 for its installer, so the download cannot be verified. Use the release page and check the hash yourself.' };
  const size = Number(installer.size) || 0;
  if (size > MAX_ASSET_BYTES) return { ...base, available: true, asset: null, reason: 'The installer for this release is larger than this app will download. Use the release page.' };
  return { ...base, available: true, asset: { name: installer.name, url: assetUrl.toString(), size, sha256 } };
}

// Streams an asset to disk, following only GitHub-hosted redirects, and keeps
// the file only if its SHA-256 matches the digest published in the release.
function downloadAsset(asset, destination, { onProgress = () => {}, timeout = 120000, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(asset.url); } catch { return reject(new Error('The update download address is not a valid URL.')); }
    if (url.protocol !== 'https:' || !ASSET_HOSTS.has(url.hostname) || url.username || url.password) {
      return reject(new Error('Refusing to download an update from an unexpected host.'));
    }
    const request = https.request(url, {
      method: 'GET', timeout, rejectUnauthorized: true,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/octet-stream' }
    }, response => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        if (redirects <= 0) return reject(new Error('GitHub redirected the update download too many times.'));
        const location = response.headers.location;
        if (!location) return reject(new Error('GitHub returned an incomplete download redirect.'));
        let next;
        try { next = new URL(location, url); } catch { return reject(new Error('GitHub returned an invalid download redirect.')); }
        return resolve(downloadAsset({ ...asset, url: next.toString() }, destination, { onProgress, timeout, redirects: redirects - 1 }));
      }
      if (status < 200 || status >= 300) { response.resume(); return reject(new Error(`GitHub returned HTTP ${status} while downloading the update.`)); }

      const partial = destination + '.part';
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const hash = createHash('sha256');
      const file = fs.createWriteStream(partial);
      let bytes = 0; let failed = false;
      const fail = error => {
        if (failed) return; failed = true;
        request.destroy(); file.destroy();
        try { fs.unlinkSync(partial); } catch { /* nothing written yet */ }
        reject(error);
      };
      response.on('data', chunk => {
        bytes += chunk.length;
        // Without this a redirected or hostile response could fill the disk.
        if (bytes > Math.max(MAX_ASSET_BYTES, asset.size * 2)) return fail(new Error('The update download was larger than the release said it would be.'));
        hash.update(chunk);
        onProgress(bytes, asset.size);
      });
      response.on('error', fail);
      file.on('error', fail);
      response.pipe(file);
      file.on('finish', () => {
        if (failed) return;
        const digest = hash.digest('hex');
        if (asset.size > 0 && bytes !== asset.size) return fail(new Error('The update download did not match the size GitHub published. It was discarded.'));
        if (digest !== asset.sha256) return fail(new Error('The update download failed its SHA-256 check and was discarded. Do not install it.'));
        try {
          fs.rmSync(destination, { force: true });
          fs.renameSync(partial, destination);
        } catch (error) { return fail(error); }
        resolve({ path: destination, sha256: digest, size: bytes });
      });
    });
    request.on('timeout', () => request.destroy(new Error('The update download timed out.')));
    // A socket error after the response started arrives here, not on the response, so the
    // fail() closure above never ran: the .part file stayed on disk and its write stream
    // stayed open. Clean up whatever exists before rejecting.
    request.on('error', error => {
      const partial = destination + '.part';
      try { fs.rmSync(partial, { force: true }); } catch { /* never created */ }
      reject(error);
    });
    request.end();
  });
}

// The digest above describes the bytes as they arrived. The user then reads a dialog and
// decides, which can take minutes, and the installer sits at a predictable path any
// process running as this user can write. Re-reading it at the moment of launch is what
// makes the dialog's promise about the file true of the file that actually runs.
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

module.exports = { parseRepository, parseVersion, compareVersions, digestFor, checkForUpdate, downloadAsset, hashFile, PLACEHOLDER_OWNER, ASSET_HOSTS };
